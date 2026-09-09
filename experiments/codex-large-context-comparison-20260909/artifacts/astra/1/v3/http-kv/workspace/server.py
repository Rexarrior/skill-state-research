#!/usr/bin/env python3
"""A small persistent JSON key-value HTTP service (Python 3.11+)."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote_to_bytes, urlsplit

MAX_BODY = 1024 * 1024


def reject_constant(value):
    raise ValueError(f"invalid JSON constant: {value}")


def decode_json(data):
    return json.loads(data, parse_constant=reject_constant)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            document = decode_json(self.path.read_text(encoding="utf-8"))
            if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("entries"), dict):
                raise ValueError("invalid persistence document")
            for key, entry in document["entries"].items():
                if not key or "/" in key or not isinstance(entry, dict) or "value" not in entry or "expires_at" not in entry:
                    raise ValueError("invalid persisted entry")
                key.encode("utf-8")
                expiry = entry["expires_at"]
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError("invalid persisted expiration")
            self.entries = self.live(document["entries"])
        # Validate writability at startup and discard expired records on disk.
        self.persist(self.entries)

    @staticmethod
    def live(entries):
        now = time.time()
        return {k: v for k, v in entries.items() if v["expires_at"] is None or v["expires_at"] > now}

    def persist(self, entries):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                             prefix=f".{self.path.name}.", suffix=".tmp", delete=False) as stream:
                temporary = stream.name
                json.dump({"version": 1, "entries": entries}, stream, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live(self.entries)
            present = key in entries
            if method == "PUT":
                expiry = None if ttl is None else time.time() + ttl
                entries[key] = {"value": value, "expires_at": expiry}
                result = (200 if present else 201, {"key": key, "value": value})
            elif method == "DELETE":
                if present:
                    del entries[key]
                result = (204, None) if present else (404, {"error": "key not found"})
            elif method == "GET":
                result = (200, {"key": key, "value": entries[key]["value"]}) if present else (404, {"error": "key not found"})
            else:
                result = (200, {"keys": sorted(entries)})
            if entries != self.entries:
                self.persist(entries)
                self.entries = entries
            return result


class ResponseSent(Exception):
    """Stop dispatch after an early HTTP response."""


class APIError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also prevents unread error bodies from being
    # interpreted as subsequent requests.
    protocol_version = "HTTP/1.0"

    def send_json(self, status, body):
        encoded = b"" if body is None else json.dumps(body, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def send_error(self, code, message=None, explain=None):
        # Includes errors detected by BaseHTTPRequestHandler's HTTP parser.
        self.send_json(405 if code == 501 else code, {"error": message or "invalid request"})

    def route(self):
        path = urlsplit(self.path).path
        if path in ("/health", "/v1/keys"):
            return path, None
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            raise APIError(404, "unknown route")
        raw = path[len(prefix):]
        if re.search(r"%(?![0-9a-fA-F]{2})", raw):
            raise APIError(400, "invalid key encoding")
        try:
            key = unquote_to_bytes(raw).decode("utf-8")
        except UnicodeError:
            raise APIError(400, "key must be UTF-8")
        if not key or "/" in key:
            raise APIError(400, "key must be nonempty and cannot contain '/' ")
        return "kv", key

    def body(self):
        if self.headers.get("Transfer-Encoding") is not None:
            raise APIError(400, "transfer encoding is unsupported; use Content-Length")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
            raise APIError(400, "invalid Content-Length")
        try:
            length = int(lengths[0]) if lengths else 0
        except ValueError:
            raise APIError(413, "request body exceeds 1 MiB")
        if length > MAX_BODY:
            # Send the rejection immediately, then allow a bounded upload to
            # finish so closing the socket does not reset the response.
            self.send_json(413, {"error": "request body exceeds 1 MiB"})
            self.wfile.flush()
            remaining = min(length, 2 * MAX_BODY)
            deadline = time.monotonic() + 1
            try:
                while remaining and time.monotonic() < deadline:
                    self.connection.settimeout(max(0.001, deadline - time.monotonic()))
                    chunk = self.rfile.read1(min(65536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
            except (TimeoutError, ConnectionError):
                pass
            raise ResponseSent
        if not length:
            if self.command == "PUT":
                raise APIError(400, "JSON body required")
            return None
        data = self.rfile.read(length)
        if len(data) != length:
            raise APIError(400, "incomplete request body")
        try:
            return decode_json(data.decode("utf-8"))
        except (ValueError, UnicodeError, RecursionError):
            raise APIError(400, "malformed JSON")

    def handle_api(self):
        try:
            payload = self.body()
            route, key = self.route()
            if self.command not in ("GET", "PUT", "DELETE") or (route != "kv" and self.command != "GET"):
                raise APIError(405, "method not allowed")
            if route == "/health":
                status, result = 200, {"status": "ok"}
            elif route == "/v1/keys":
                status, result = self.server.store.operate("LIST")
            elif self.command == "PUT":
                if not isinstance(payload, dict) or "value" not in payload or set(payload) - {"value", "ttl_seconds"}:
                    raise APIError(400, "expected an object with value and optional ttl_seconds")
                ttl = payload.get("ttl_seconds")
                if "ttl_seconds" in payload:
                    try:
                        valid = type(ttl) in (int, float) and math.isfinite(ttl) and ttl > 0 and math.isfinite(time.time() + ttl)
                    except OverflowError:
                        valid = False
                    if not valid:
                        raise APIError(400, "ttl_seconds must be finite and greater than zero")
                # Reject numbers parsed to infinity (e.g. 1e999), including in nested values.
                try:
                    json.dumps(payload, allow_nan=False)
                except (ValueError, RecursionError):
                    raise APIError(400, "value must be valid JSON")
                status, result = self.server.store.operate("PUT", key, payload["value"], ttl)
            else:
                status, result = self.server.store.operate(self.command, key)
            self.send_json(status, result)
        except ResponseSent:
            self.close_connection = True
        except APIError as exc:
            self.send_json(exc.status, {"error": exc.message})
        except (TimeoutError, ConnectionError):
            self.close_connection = True
        except Exception as exc:
            print(f"request failed: {exc}", file=sys.stderr, flush=True)
            self.send_json(500, {"error": "internal server error"})

    do_GET = do_PUT = do_DELETE = do_POST = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT = handle_api


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(2)
        return connection, address


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
        server.store = store
    except (OSError, ValueError, OverflowError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr)
        return 1
    stopping = threading.Event()

    def stop(signum, frame):
        if not stopping.is_set():
            stopping.set()
            # shutdown must run outside the serve_forever thread.
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
