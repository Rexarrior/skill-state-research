#!/usr/bin/env python3
"""Dependency-free persistent HTTP key-value service."""
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


def decode_json(data):
    return json.loads(data, parse_constant=reject_constant)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.entries = {}
        if self.path.exists():
            document = decode_json(self.path.read_text(encoding="utf-8"))
            if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("entries"), dict):
                raise ValueError("Invalid persistence file")
            for key, entry in document["entries"].items():
                if not key or "/" in key or not isinstance(entry, dict) or "value" not in entry or "expires_at" not in entry:
                    raise ValueError("Invalid persisted entry")
                key.encode("utf-8")
                expiry = entry["expires_at"]
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError("Invalid persisted expiration")
            self.entries = document["entries"]
        self.persist(self.live())

    def live(self):
        now = time.time()
        return {k: v for k, v in self.entries.items() if v["expires_at"] is None or v["expires_at"] > now}

    def persist(self, entries):
        # Commit memory only after the durable file replacement succeeds.
        payload = json.dumps({"version": 1, "entries": entries}, ensure_ascii=True, allow_nan=False).encode("utf-8")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=f".{self.path.name}.", delete=False) as output:
                temporary = output.name
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            temporary = None
            self.entries = entries
        finally:
            if temporary is not None:
                os.unlink(temporary)

    def execute(self, operation, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            if operation == "keys":
                return 200, {"keys": sorted(entries)}
            if operation == "get":
                if key not in entries:
                    return 404, {"error": "Key not found"}
                return 200, {"key": key, "value": entries[key]["value"]}
            if operation == "put":
                status = 200 if key in entries else 201
                entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
                self.persist(entries)
                return status, {"key": key, "value": value}
            if key not in entries:
                return 404, {"error": "Key not found"}
            del entries[key]
            self.persist(entries)
            return 204, None


class Handler(BaseHTTPRequestHandler):
    # Closing after each response also prevents unread rejected bodies from
    # being interpreted as another request.
    protocol_version = "HTTP/1.0"

    def send_json(self, status, body):
        payload = b"" if body is None else json.dumps(body, ensure_ascii=True, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)
        self.close_connection = True

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.handle_api
        raise AttributeError(name)

    def handle_api(self):
        try:
            self.route()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.log_error("Request failed: %s", exc)
            self.send_json(500, {"error": "Internal server error"})

    def route(self):
        if self.headers.get("Transfer-Encoding") is not None:
            return self.send_json(400, {"error": "Transfer-Encoding is unsupported"})
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
            return self.send_json(400, {"error": "Invalid Content-Length"})
        # Avoid converting unbounded attacker-controlled decimal strings.
        if lengths and (len(lengths[0].lstrip("0")) > 7 or int(lengths[0].lstrip("0") or "0") > MAX_BODY):
            return self.send_json(413, {"error": "Request body exceeds 1 MiB"})
        length = int(lengths[0].lstrip("0") or "0") if lengths else 0
        try:
            path = urlsplit(self.path).path
        except ValueError:
            return self.send_json(400, {"error": "Invalid URL"})
        if path == "/health":
            if self.command != "GET":
                return self.send_json(405, {"error": "Method not allowed"})
            return self.send_json(200, {"status": "ok"})
        if path == "/v1/keys":
            if self.command != "GET":
                return self.send_json(405, {"error": "Method not allowed"})
            return self.send_json(*self.server.store.execute("keys"))
        if not path.startswith("/v1/kv/"):
            return self.send_json(404, {"error": "Unknown route"})
        encoded = path[len("/v1/kv/"):]
        try:
            if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
                raise ValueError("Invalid percent escape")
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
            if not key or "/" in key:
                raise ValueError("Invalid key")
        except (ValueError, UnicodeError):
            return self.send_json(400, {"error": "Invalid key"})
        if self.command not in ("GET", "PUT", "DELETE"):
            return self.send_json(405, {"error": "Method not allowed"})
        if self.command != "PUT":
            return self.send_json(*self.server.store.execute(self.command.lower(), key))
        if not lengths:
            return self.send_json(411, {"error": "Content-Length is required"})
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete body")
            body = decode_json(raw.decode("utf-8"))
            if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                raise ValueError("Expected value and optional ttl_seconds")
            # Reject overflowed JSON floats, including those nested in values.
            json.dumps(body, allow_nan=False)
            ttl = body.get("ttl_seconds")
            if "ttl_seconds" in body:
                if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
                    raise ValueError("TTL must be finite and positive")
        except (ValueError, UnicodeError, OverflowError, RecursionError) as exc:
            return self.send_json(400, {"error": str(exc)})
        self.send_json(*self.server.store.execute("put", key, body["value"], ttl))


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
        server.store = store
    except (OSError, ValueError, OverflowError) as exc:
        print(f"Startup failed: {exc}", file=sys.stderr)
        return 1
    stopping = threading.Event()

    def stop(signum, frame):
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        with store.lock:
            store.persist(store.live())
    return 0


if __name__ == "__main__":
    sys.exit(main())
