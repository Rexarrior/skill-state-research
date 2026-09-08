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


def decode_json(raw):
    return json.loads(raw, parse_constant=reject_constant)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.entries = {}
        if self.path.exists():
            data = decode_json(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("entries"), dict):
                raise ValueError("Invalid persistence file")
            for key, entry in data["entries"].items():
                if not valid_key(key) or not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("Invalid persisted entry")
                expiry = entry.get("expires_at")
                if expiry is not None and not finite_number(expiry):
                    raise ValueError("Invalid persisted expiry")
            self.entries = data["entries"]
        # Prune expired data on startup and verify persistence is writable.
        self.commit(self.live())

    def live(self):
        now = time.time()
        return {key: entry for key, entry in self.entries.items()
                if entry.get("expires_at") is None or entry["expires_at"] > now}

    def commit(self, entries):
        raw = json.dumps({"version": 1, "entries": entries}, ensure_ascii=True,
                         allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=".kv-", delete=False) as file:
                name = file.name
                file.write(raw)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
            self.entries = entries
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)


def finite_number(value):
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    except OverflowError:
        return False


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8")
        return True
    except UnicodeError:
        return False


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also prevents unread invalid bodies being reused.
    protocol_version = "HTTP/1.0"

    def reply(self, status, body=None):
        raw = b"" if body is None else json.dumps(body, ensure_ascii=True, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def route(self):
        try:
            path = urlsplit(self.path).path
        except ValueError:
            raise ValueError("Invalid request target")
        if path in ("/health", "/v1/keys"):
            return path, None
        prefix = "/v1/kv/"
        if path.startswith(prefix):
            encoded = path[len(prefix):]
            if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
                raise ValueError("Invalid key encoding")
            try:
                key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
            except UnicodeError:
                raise ValueError("Key must be UTF-8") from None
            if not valid_key(key):
                raise ValueError("Key must be nonempty and cannot contain '/' ")
            return "kv", key
        return None, None

    def body(self):
        if self.headers.get("Transfer-Encoding") is not None:
            self.send_error(400, "Transfer-Encoding is not supported")
            return None
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
            self.send_error(400, "A valid Content-Length is required")
            return None
        try:
            size = int(lengths[0])
        except ValueError:
            self.send_error(413, "Request body exceeds 1 MiB")
            return None
        if size > MAX_BODY:
            self.send_error(413, "Request body exceeds 1 MiB")
            return None
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise ValueError("Incomplete request body")
        obj = decode_json(raw.decode("utf-8"))
        if not isinstance(obj, dict) or "value" not in obj or set(obj) - {"value", "ttl_seconds"}:
            raise ValueError("Expected value and optional ttl_seconds")
        if "ttl_seconds" in obj:
            ttl = obj["ttl_seconds"]
            if not finite_number(ttl) or ttl <= 0 or not finite_number(time.time() + ttl):
                raise ValueError("ttl_seconds must be finite and greater than zero")
        # Reject overflowing JSON numbers anywhere in the value.
        json.dumps(obj, allow_nan=False)
        return obj

    def handle_api(self):
        try:
            route, key = self.route()
            if route is None:
                self.send_error(404, "Unknown route")
                return
            allowed = ("GET", "PUT", "DELETE") if route == "kv" else ("GET",)
            if self.command not in allowed:
                self.send_error(405, "Method not allowed")
                return
            if self.command == "GET" and route == "/health":
                self.reply(200, {"status": "ok"})
                return
            obj = self.body() if self.command == "PUT" else None
            if self.command == "PUT" and obj is None:
                return
            store = self.server.store
            with store.lock:
                entries = store.live()
                if route == "/v1/keys":
                    status, response = 200, {"keys": sorted(entries)}
                elif self.command == "GET":
                    status, response = ((200, {"key": key, "value": entries[key]["value"]})
                                        if key in entries else (404, {"error": "Key not found"}))
                elif self.command == "PUT":
                    status = 200 if key in entries else 201
                    entries[key] = {"value": obj["value"], "expires_at":
                                    time.time() + obj["ttl_seconds"] if "ttl_seconds" in obj else None}
                    store.commit(entries)
                    response = {"key": key, "value": obj["value"]}
                else:
                    if key in entries:
                        del entries[key]
                        store.commit(entries)
                        status, response = 204, None
                    else:
                        status, response = 404, {"error": "Key not found"}
            self.reply(status, response)
        except (ValueError, UnicodeError, RecursionError) as error:
            self.send_error(400, str(error))
        except TimeoutError:
            self.send_error(408, "Request timed out")
        except OSError as error:
            self.log_error("I/O failure: %s", error)
            self.send_error(500, "Storage or connection failure")

    do_GET = do_PUT = do_DELETE = do_POST = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT = handle_api

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.handle_api
        raise AttributeError(name)


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
    except (OSError, ValueError) as error:
        print(f"Startup failed: {error}", file=sys.stderr)
        return 1
    server.store = store
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
