#!/usr/bin/env python3
"""A persistent, dependency-free HTTP key-value service."""
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
    raise ValueError(f"Invalid JSON constant: {value}")


def decode_json(raw):
    return json.loads(raw.decode("utf-8"), parse_constant=reject_constant)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.entries = {}
        if self.path.exists():
            document = decode_json(self.path.read_bytes())
            if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("entries"), dict):
                raise ValueError("Invalid persistence file")
            for key, entry in document["entries"].items():
                if not valid_key(key) or not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("Invalid persisted entry")
                expires = entry.get("expires_at")
                if expires is not None and (type(expires) not in (int, float) or not math.isfinite(expires)):
                    raise ValueError("Invalid persisted expiration")
            self.entries = document["entries"]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Also discard expired records on disk on every startup.
        self.commit(self.live())

    def live(self):
        now = time.time()
        return {key: entry for key, entry in self.entries.items()
                if entry.get("expires_at") is None or entry["expires_at"] > now}

    def commit(self, entries):
        payload = json.dumps({"version": 1, "entries": entries}, ensure_ascii=True, allow_nan=False).encode("utf-8")
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=f".{self.path.name}.", delete=False) as stream:
                name = stream.name
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)
        self.entries = entries

    def access(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            present = key in entries
            if method == "PUT":
                entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
                self.commit(entries)
                return (200 if present else 201), {"key": key, "value": value}
            if method == "DELETE" and present:
                del entries[key]
            if entries != self.entries:
                self.commit(entries)
            if method == "DELETE":
                return (204, None) if present else (404, {"error": "Key not found"})
            if method == "KEYS":
                return 200, {"keys": sorted(entries)}
            if present:
                return 200, {"key": key, "value": entries[key]["value"]}
            return 404, {"error": "Key not found"}


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8")
    except UnicodeError:
        return False
    return True


class APIError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    # Closing each connection avoids ambiguous framing and unread-body reuse.
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def respond(self, status, body):
        data = b"" if status == 204 else json.dumps(body, ensure_ascii=True, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        self.close_connection = True

    def send_error(self, code, message=None, explain=None):
        if code == 501:
            code, message = 405, "Method not allowed"
        self.respond(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def dispatch(self):
        try:
            if self.headers.get("Transfer-Encoding") is not None:
                raise APIError(400, "Transfer-Encoding is not supported")
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
                raise APIError(400, "Invalid Content-Length")
            if lengths and (len(lengths[0]) > 10 or int(lengths[0]) > MAX_BODY):
                raise APIError(413, "Request body exceeds 1 MiB")
            length = int(lengths[0]) if lengths else 0
            path = urlsplit(self.path).path
            if path in ("/health", "/v1/keys"):
                if self.command != "GET":
                    raise APIError(405, "Method not allowed")
                if path == "/health":
                    self.respond(200, {"status": "ok"})
                else:
                    self.respond(*self.server.store.access("KEYS"))
                return
            if not path.startswith("/v1/kv/"):
                raise APIError(404, "Unknown route")
            encoded = path[len("/v1/kv/"):]
            if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
                raise APIError(400, "Invalid key encoding")
            try:
                key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
            except UnicodeError:
                raise APIError(400, "Key must be UTF-8")
            if not valid_key(key):
                raise APIError(400, "Key must be nonempty and contain no slash")
            if self.command not in ("GET", "PUT", "DELETE"):
                raise APIError(405, "Method not allowed")
            if self.command == "PUT":
                if not lengths:
                    raise APIError(411, "Content-Length is required")
                try:
                    raw = self.rfile.read(length)
                except TimeoutError:
                    raise APIError(408, "Request body timed out")
                if len(raw) != length:
                    raise APIError(400, "Incomplete request body")
                try:
                    body = decode_json(raw)
                    # Reject overflowed JSON numbers, including nested values.
                    json.dumps(body, allow_nan=False)
                except (ValueError, UnicodeError, RecursionError):
                    raise APIError(400, "Malformed JSON")
                if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                    raise APIError(400, "Expected value and optional ttl_seconds")
                ttl = body.get("ttl_seconds")
                if "ttl_seconds" in body:
                    try:
                        valid = type(ttl) in (int, float) and math.isfinite(ttl) and ttl > 0 and math.isfinite(time.time() + ttl)
                    except OverflowError:
                        valid = False
                    if not valid:
                        raise APIError(400, "ttl_seconds must be finite and greater than zero")
                self.respond(*self.server.store.access("PUT", key, body["value"], ttl))
            else:
                self.respond(*self.server.store.access(self.command, key))
        except APIError as exc:
            self.respond(exc.status, {"error": exc.message})
        except (ValueError, UnicodeError):
            self.respond(400, {"error": "Invalid request"})
        except OSError as exc:
            print(f"Request failed: {exc}", file=sys.stderr, flush=True)
            try:
                self.respond(500, {"error": "Storage or connection failure"})
            except OSError:
                pass

    do_GET = do_PUT = do_DELETE = do_POST = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT = dispatch


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
    except (OSError, ValueError, OverflowError) as exc:
        print(f"Startup failed: {exc}", file=sys.stderr)
        return 1
    server.store = store
    stopping = threading.Event()

    def stop(signum, frame):
        if not stopping.is_set():
            stopping.set()
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
