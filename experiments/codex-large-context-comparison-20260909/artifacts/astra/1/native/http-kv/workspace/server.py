#!/usr/bin/env python3
"""A small, durable HTTP key-value service using only the standard library."""

import argparse
import json
import math
import os
import re
import signal
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote_to_bytes


MAX_BODY = 1024 * 1024


def reject_constant(value):
    raise ValueError(f"Invalid JSON number: {value}")


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False,
                      separators=(",", ":")).encode("utf-8")


def decode_json(data):
    value = json.loads(data.decode("utf-8"), parse_constant=reject_constant)
    # Also reject numbers such as 1e999, which json.loads converts to infinity.
    encode_json(value)
    return value


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
            document = decode_json(self.path.read_bytes())
            if (not isinstance(document, dict) or document.get("version") != 1
                    or not isinstance(document.get("entries"), dict)):
                raise ValueError("Invalid data file format")
            for key, entry in document["entries"].items():
                if not valid_key(key) or not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("Invalid entry in data file")
                expires = entry.get("expires_at")
                if expires is not None and (isinstance(expires, bool)
                        or not isinstance(expires, (int, float)) or not math.isfinite(expires)):
                    raise ValueError("Invalid expiration in data file")
            self.entries = self._live(document["entries"])
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _live(entries):
        now = time.time()
        return {key: entry for key, entry in entries.items()
                if entry.get("expires_at") is None or entry["expires_at"] > now}

    def _commit(self, entries):
        payload = encode_json({"version": 1, "entries": entries})
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent,
                                             prefix=f".{self.path.name}.",
                                             delete=False) as output:
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

    def put(self, key, value, ttl):
        with self.lock:
            entries = self._live(self.entries)
            created = key not in entries
            expires = None if ttl is None else time.time() + ttl
            if expires is not None and not math.isfinite(expires):
                raise ValueError("TTL is too large")
            entries[key] = {"value": value, "expires_at": expires}
            self._commit(entries)
            return created

    def get(self, key):
        with self.lock:
            self.entries = self._live(self.entries)
            return self.entries[key]["value"]

    def delete(self, key):
        with self.lock:
            entries = self._live(self.entries)
            del entries[key]
            self._commit(entries)

    def keys(self):
        with self.lock:
            self.entries = self._live(self.entries)
            return sorted(self.entries)


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also prevents unread/invalid bodies from becoming
    # another request. Socket timeouts bound shutdown with idle clients.
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def respond(self, status, body=None, headers=None):
        payload = b"" if body is None else encode_json(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.respond(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def route(self):
        path = self.path.partition("?")[0]
        if path in ("/health", "/v1/keys"):
            return path, None
        if path.startswith("/v1/kv/"):
            raw = path[len("/v1/kv/"):]
            if re.search(r"%(?![0-9a-fA-F]{2})", raw):
                raise ValueError("Invalid key encoding")
            key = unquote_to_bytes(raw).decode("utf-8", errors="strict")
            if not valid_key(key):
                raise ValueError("Invalid key")
            return "/v1/kv/", key
        return None, None

    def dispatch(self):
        try:
            if self.headers.get("Transfer-Encoding") is not None:
                self.send_error(400, "Transfer-Encoding is not supported")
                return
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
                self.send_error(400, "Invalid Content-Length")
                return
            # Avoid converting unbounded decimal strings to Python integers.
            length_text = (lengths[0].lstrip("0") or "0") if lengths else "0"
            if len(length_text) > 7 or int(length_text) > MAX_BODY:
                self.send_error(413, "Request body exceeds 1 MiB")
                return
            length = int(length_text)
            route, key = self.route()
            if route is None:
                self.send_error(404, "Unknown route")
                return
            allowed = "GET, PUT, DELETE" if key is not None else "GET"
            if self.command not in allowed.split(", "):
                self.respond(405, {"error": "Method not allowed"}, {"Allow": allowed})
                return
            if route == "/health":
                self.respond(200, {"status": "ok"})
            elif route == "/v1/keys":
                self.respond(200, {"keys": self.server.store.keys()})
            elif self.command == "GET":
                self.respond(200, {"key": key, "value": self.server.store.get(key)})
            elif self.command == "DELETE":
                self.server.store.delete(key)
                self.respond(204)
            else:
                if not lengths:
                    self.send_error(411, "Content-Length is required")
                    return
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError("Incomplete request body")
                body = decode_json(data)
                if not isinstance(body, dict) or "value" not in body:
                    raise ValueError("Expected an object containing value")
                ttl = body.get("ttl_seconds")
                if "ttl_seconds" in body:
                    if (isinstance(ttl, bool) or not isinstance(ttl, (int, float))
                            or not math.isfinite(ttl) or ttl <= 0):
                        raise ValueError("ttl_seconds must be a finite positive number")
                created = self.server.store.put(key, body["value"], ttl)
                self.respond(201 if created else 200, {"key": key, "value": body["value"]})
        except KeyError:
            self.send_error(404, "Key not found")
        except (ValueError, UnicodeError, OverflowError, RecursionError):
            self.send_error(400, "Invalid JSON, key, or TTL")
        except TimeoutError:
            self.send_error(408, "Request timed out")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as exc:
            self.log_error("Storage or connection error: %s", exc)
            self.send_error(500, "Storage error")

    do_GET = dispatch
    do_PUT = dispatch
    do_DELETE = dispatch

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
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
    except (OSError, ValueError, OverflowError, RecursionError) as exc:
        print(f"Startup failed: {exc}", file=sys.stderr)
        return 1
    server.store = store
    server.timeout = 0.2
    stopped = threading.Event()

    def stop(signum, frame):
        stopped.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_port}", flush=True)
    try:
        while not stopped.is_set():
            server.handle_request()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
