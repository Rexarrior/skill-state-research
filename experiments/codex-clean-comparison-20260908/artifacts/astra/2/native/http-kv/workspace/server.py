#!/usr/bin/env python3
"""A small, durable HTTP key-value service using only the standard library."""

import argparse
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024


def reject_constant(value):
    raise ValueError(f"Invalid JSON number: {value}")


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("JSON number must be finite")
    return number


def decode_json(data):
    return json.loads(data.decode("utf-8"), parse_constant=reject_constant,
                      parse_float=finite_float)


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False,
                      separators=(",", ":")).encode("utf-8")


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
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            document = decode_json(self.path.read_bytes())
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("Invalid state file format")
            entries = document.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("Invalid state entries")
            for key, entry in entries.items():
                if (not valid_key(key) or not isinstance(entry, dict)
                        or set(entry) != {"value", "expires_at"}):
                    raise ValueError("Invalid state entry")
                expiry = entry["expires_at"]
                if expiry is not None and (type(expiry) not in (int, float)
                                           or not math.isfinite(expiry)):
                    raise ValueError("Invalid state expiry")
            self.entries = entries
        # Validate writability and discard entries that expired while offline.
        self.flush()

    def live(self):
        now = time.time()
        return {key: entry for key, entry in self.entries.items()
                if entry["expires_at"] is None or entry["expires_at"] > now}

    def commit(self, entries):
        data = encode_json({"version": 1, "entries": entries})
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent,
                                             prefix=f".{self.path.name}.",
                                             delete=False) as output:
                temporary = output.name
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            temporary = None
            self.entries = entries
        finally:
            if temporary is not None:
                os.unlink(temporary)

    def flush(self):
        with self.lock:
            self.commit(self.live())

    def get(self, key):
        with self.lock:
            entry = self.entries.get(key)
            if entry is None or (entry["expires_at"] is not None
                                 and entry["expires_at"] <= time.time()):
                return None
            return {"key": key, "value": entry["value"]}

    def keys(self):
        with self.lock:
            return sorted(self.live())

    def put(self, key, value, ttl):
        with self.lock:
            entries = self.live()
            created = key not in entries
            expires_at = None if ttl is None else time.time() + ttl
            if expires_at is not None and not math.isfinite(expires_at):
                raise ValueError("TTL expiry must be finite")
            entries[key] = {"value": value, "expires_at": expires_at}
            self.commit(entries)
            return created

    def delete(self, key):
        with self.lock:
            entries = self.live()
            if key not in entries:
                return False
            del entries[key]
            self.commit(entries)
            return True


class HTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


class Handler(BaseHTTPRequestHandler):
    # One request per connection prevents unread/rejected bodies being reused.
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def reply(self, status, value=None):
        body = b"" if status == 204 else encode_json(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if status == 405:
            self.send_header("Allow", "GET, PUT, DELETE")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        self.reply(405 if code == 501 else code,
                   {"error": message or self.responses.get(code, ("Error",))[0]})

    def route(self):
        path = urlsplit(self.path).path
        if path in ("/health", "/v1/keys"):
            return path, None
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None, None
        raw = path[len(prefix):]
        if re.search(r"%(?![0-9a-fA-F]{2})", raw):
            raise ValueError("Invalid key encoding")
        key = unquote_to_bytes(raw).decode("utf-8", errors="strict")
        if not valid_key(key):
            raise ValueError("Key must be nonempty UTF-8 without '/' ")
        return "kv", key

    def body_length(self):
        if self.headers.get("Transfer-Encoding") is not None:
            raise ValueError("Transfer-Encoding is unsupported; use Content-Length")
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths:
            return 0
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
            raise ValueError("Invalid Content-Length")
        length = int(lengths[0])
        return length

    def reject_large_body(self):
        self.reply(413, {"error": "Request body exceeds 1 MiB"})
        # Deliver the error before closing, while allowing an in-flight upload
        # to finish without a TCP reset. Discard in bounded chunks and time.
        self.wfile.flush()
        self.connection.shutdown(socket.SHUT_WR)
        self.connection.settimeout(0.2)
        deadline = time.monotonic() + 1
        try:
            while time.monotonic() < deadline and self.rfile.read1(65536):
                pass
        except OSError:
            pass

    def dispatch(self):
        try:
            length = self.body_length()
            if length > MAX_BODY:
                self.reject_large_body()
                return
            route, key = self.route()
            if route is None:
                self.reply(404, {"error": "Unknown route"})
                return
            if self.command != "GET" and route != "kv":
                self.reply(405, {"error": "Method not allowed"})
                return
            store = self.server.store
            if route == "/health":
                self.reply(200, {"status": "ok"})
            elif route == "/v1/keys":
                self.reply(200, {"keys": store.keys()})
            elif self.command == "GET":
                value = store.get(key)
                self.reply(404 if value is None else 200,
                           {"error": "Key not found"} if value is None else value)
            elif self.command == "DELETE":
                deleted = store.delete(key)
                self.reply(204 if deleted else 404,
                           None if deleted else {"error": "Key not found"})
            elif self.command == "PUT":
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError("Incomplete request body")
                body = decode_json(data)
                if (not isinstance(body, dict) or "value" not in body
                        or set(body) - {"value", "ttl_seconds"}):
                    raise ValueError("Expected value and optional ttl_seconds")
                ttl = body.get("ttl_seconds")
                if "ttl_seconds" in body and (type(ttl) not in (int, float)
                                              or not math.isfinite(ttl) or ttl <= 0):
                    raise ValueError("ttl_seconds must be finite and greater than zero")
                created = store.put(key, body["value"], ttl)
                self.reply(201 if created else 200, {"key": key, "value": body["value"]})
        except (ValueError, UnicodeError, OverflowError, RecursionError) as error:
            self.reply(400, {"error": str(error) or "Invalid request"})
        except TimeoutError:
            self.reply(408, {"error": "Request timed out"})
        except OSError as error:
            print(f"Request failed: {error}", file=sys.stderr, flush=True)
            try:
                self.reply(500, {"error": "Storage or connection failure"})
            except OSError:
                pass

    do_GET = dispatch
    do_PUT = dispatch
    do_DELETE = dispatch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--data", required=True, type=Path)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = HTTPServer((args.host, args.port), Handler)
        server.store = store
    except (OSError, ValueError, OverflowError, RecursionError) as error:
        print(f"Startup failed: {error}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop(signum, frame):
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_port}", flush=True)
    exit_status = 0
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        try:
            store.flush()
        except OSError as error:
            print(f"Shutdown persistence failed: {error}", file=sys.stderr, flush=True)
            exit_status = 1
    return exit_status


if __name__ == "__main__":
    sys.exit(main())
