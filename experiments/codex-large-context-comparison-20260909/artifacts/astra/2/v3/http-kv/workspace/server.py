#!/usr/bin/env python3
"""A small persistent, thread-safe JSON HTTP key-value service."""

import argparse
import json
import logging
import math
import os
from pathlib import Path
import re
import signal
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

MAX_BODY = 1024 * 1024
LOG = logging.getLogger("kv")


def reject_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def decode_json(data):
    return json.loads(data, parse_constant=reject_constant)


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8")
    except UnicodeError:
        return False
    return True


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            document = decode_json(self.path.read_bytes().decode("utf-8"))
            if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("entries"), dict):
                raise ValueError("Invalid persistence document")
            for key, entry in document["entries"].items():
                if not valid_key(key) or not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("Invalid persisted entry")
                expiry = entry["expires_at"]
                if expiry is not None and (isinstance(expiry, bool) or not isinstance(expiry, (int, float)) or not math.isfinite(expiry)):
                    raise ValueError("Invalid persisted expiry")
            encode_json(document)  # Reject non-finite nested values as well.
            self.entries = document["entries"]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.entries = self.live()
        self.persist(self.entries)

    def live(self):
        now = time.time()
        return {key: entry for key, entry in self.entries.items()
                if entry["expires_at"] is None or entry["expires_at"] > now}

    def persist(self, entries):
        data = encode_json({"version": 1, "entries": entries})
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=f".{self.path.name}.", delete=False) as stream:
                name = stream.name
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)

    def execute(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            if method == "PUT":
                status = 200 if key in entries else 201
                expiry = None if ttl is None else time.time() + ttl
                if expiry is not None and not math.isfinite(expiry):
                    raise ValueError("TTL is too large")
                entries[key] = {"value": value, "expires_at": expiry}
                result = {"key": key, "value": value}
            elif method == "DELETE":
                status = 204 if key in entries else 404
                entries.pop(key, None)
                result = None if status == 204 else {"error": "Key not found"}
            elif method == "KEYS":
                status, result = 200, {"keys": sorted(entries)}
            elif key in entries:
                status, result = 200, {"key": key, "value": entries[key]["value"]}
            else:
                status, result = 404, {"error": "Key not found"}
            if method == "PUT" or method == "DELETE" or len(entries) != len(self.entries):
                self.persist(entries)
            self.entries = entries
            return status, result

    def flush(self):
        with self.lock:
            entries = self.live()
            self.persist(entries)
            self.entries = entries


class RequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    # Close after each request, including rejected requests with unread bodies.
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, fmt, *args):
        LOG.info("%s %s", self.address_string(), fmt % args)

    def send_json(self, status, payload):
        data = b"" if status == 204 else encode_json(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {"error": message or self.responses.get(code, ("Request failed",))[0]})

    def body_length(self):
        if self.headers.get_all("Transfer-Encoding"):
            raise RequestError(400, "Transfer-Encoding is not supported")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
            raise RequestError(400, "Invalid Content-Length")
        try:
            length = int(lengths[0]) if lengths else 0
        except ValueError:
            raise RequestError(413, "Request body exceeds 1 MiB")
        if length > MAX_BODY:
            raise RequestError(413, "Request body exceeds 1 MiB")
        return length

    def handle_api(self):
        length = self.body_length()
        if self.command not in {"GET", "PUT", "DELETE"}:
            raise RequestError(405, "Unsupported method")
        try:
            path = urlsplit(self.path).path
        except ValueError:
            raise RequestError(400, "Invalid URL")
        if path in {"/health", "/v1/keys"}:
            if self.command != "GET":
                raise RequestError(405, "Unsupported method")
            if path == "/health":
                return 200, {"status": "ok"}
            return self.server.store.execute("KEYS")
        if not path.startswith("/v1/kv/"):
            raise RequestError(404, "Unknown route")
        raw_key = path[len("/v1/kv/"):]
        if re.search(r"%(?![0-9a-fA-F]{2})", raw_key):
            raise RequestError(400, "Invalid key encoding")
        try:
            key = unquote(raw_key, encoding="utf-8", errors="strict")
        except UnicodeError:
            raise RequestError(400, "Key must be UTF-8")
        if not valid_key(key):
            raise RequestError(400, "Key must be nonempty and cannot contain a slash")
        if self.command != "PUT":
            return self.server.store.execute(self.command, key)
        try:
            data = self.rfile.read(length)
            if len(data) != length:
                raise RequestError(400, "Incomplete request body")
            body = decode_json(data.decode("utf-8"))
            # Also reject JSON numbers that overflow to infinity in nested values.
            encode_json(body)
        except (ValueError, UnicodeError, RecursionError):
            raise RequestError(400, "Malformed JSON")
        if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
            raise RequestError(400, "Expected value and optional ttl_seconds")
        ttl = body.get("ttl_seconds")
        if "ttl_seconds" in body:
            try:
                valid = not isinstance(ttl, bool) and isinstance(ttl, (int, float)) and math.isfinite(ttl) and ttl > 0
            except OverflowError:
                valid = False
            if not valid:
                raise RequestError(400, "TTL must be finite and greater than zero")
        return self.server.store.execute("PUT", key, body["value"], ttl)

    def dispatch(self):
        try:
            status, result = self.handle_api()
        except RequestError as exc:
            status, result = exc.status, {"error": exc.message}
        except TimeoutError:
            status, result = 408, {"error": "Request timed out"}
        except ValueError as exc:
            status, result = 400, {"error": str(exc)}
        except Exception:
            LOG.exception("Request failed")
            status, result = 500, {"error": "Internal server error"}
        try:
            self.send_json(status, result)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    do_GET = do_PUT = do_DELETE = do_POST = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT = dispatch

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.dispatch
        raise AttributeError(name)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
    except Exception:
        LOG.exception("Startup failed")
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
        server.server_close()  # Wait for in-flight requests before the final flush.
        store.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
