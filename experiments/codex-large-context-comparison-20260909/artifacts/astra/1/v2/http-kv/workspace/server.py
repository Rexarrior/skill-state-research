#!/usr/bin/env python3
"""Dependency-free persistent HTTP key-value service."""
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
from urllib.parse import unquote, urlsplit

MAX_BODY = 1024 * 1024


def reject_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def loads(data):
    return json.loads(data, parse_constant=reject_constant)


def encode(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            document = loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("entries"), dict):
                raise ValueError("Invalid data file")
            for key, entry in document["entries"].items():
                if not valid_key(key) or not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("Invalid stored entry")
                expiry = entry.get("expires_at")
                if expiry is not None and (type(expiry) not in (int, float) or not finite(expiry)):
                    raise ValueError("Invalid stored expiration")
                encode(entry["value"])
            self.entries = document["entries"]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Validate writability and discard expired records on startup.
        self.entries = self.live()
        self.persist(self.entries)

    def live(self):
        now = time.time()
        return {key: entry for key, entry in self.entries.items()
                if entry.get("expires_at") is None or entry["expires_at"] > now}

    def persist(self, entries):
        data = encode({"version": 1, "entries": entries})
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=f".{self.path.name}.", delete=False) as file:
                temporary = file.name
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            if method == "GET":
                return (200, {"key": key, "value": entries[key]["value"]}) if key in entries else (404, {"error": "Key not found"})
            if method == "KEYS":
                return 200, {"keys": sorted(entries)}
            if method == "PUT":
                status = 200 if key in entries else 201
                entries[key] = {"value": value, "expires_at": time.time() + ttl if ttl is not None else None}
                response = {"key": key, "value": value}
            else:
                if key not in entries:
                    return 404, {"error": "Key not found"}
                del entries[key]
                status, response = 204, None
            self.persist(entries)
            self.entries = entries
            return status, response


def finite(value):
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8")
    except UnicodeError:
        return False
    return True


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also prevents unread error bodies becoming requests.
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def finish(self):
        try:
            super().finish()
        finally:
            # Deliver early errors even when a client is still uploading. A
            # bounded drain avoids a TCP reset without accepting a large body.
            try:
                self.connection.shutdown(socket.SHUT_WR)
                deadline = time.monotonic() + 1
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self.connection.settimeout(remaining)
                    if not self.connection.recv(65536):
                        break
            except OSError:
                pass

    def send_json(self, status, body):
        data = b"" if status == 204 else encode(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_error(self, code, message=None, explain=None):
        if code == 501:
            code, message = 405, "Method not allowed"
        self.send_json(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def dispatch(self):
        try:
            self.handle_api()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except TimeoutError:
            self.send_error(408, "Request timed out")
        except Exception as error:
            print(f"Request failed: {error}", file=sys.stderr, flush=True)
            self.send_error(500, "Internal server error")

    def handle_api(self):
        if self.headers.get("Transfer-Encoding") is not None:
            self.send_error(400, "Transfer-Encoding is unsupported")
            return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
            self.send_error(400, "Invalid Content-Length")
            return
        if lengths and len(lengths[0]) > 10:
            self.send_error(413, "Request body too large")
            return
        length = int(lengths[0]) if lengths else 0
        if length > MAX_BODY:
            self.send_error(413, "Request body too large")
            return
        try:
            path = urlsplit(self.path).path
        except ValueError:
            self.send_error(400, "Invalid URL")
            return
        key = None
        if path.startswith("/v1/kv/"):
            raw_key = path[len("/v1/kv/"):]
            try:
                if re.search(r"%(?![0-9a-fA-F]{2})", raw_key):
                    raise ValueError()
                key = unquote(raw_key, encoding="utf-8", errors="strict")
                if not valid_key(key):
                    raise ValueError()
            except (ValueError, UnicodeError):
                self.send_error(400, "Invalid key")
                return
            allowed = ("GET", "PUT", "DELETE")
        elif path in ("/health", "/v1/keys"):
            allowed = ("GET",)
        else:
            self.send_error(404, "Unknown route")
            return
        if self.command not in allowed:
            self.send_error(405, "Method not allowed")
            return
        if self.command == "PUT":
            if not lengths:
                self.send_error(411, "Content-Length required")
                return
            try:
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError()
                body = loads(raw.decode("utf-8"))
                if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                    raise ValueError()
                ttl = body.get("ttl_seconds")
                if "ttl_seconds" in body and (type(ttl) not in (int, float) or not finite(ttl) or ttl <= 0):
                    raise ValueError()
                encode(body)
            except (ValueError, UnicodeError, RecursionError, OverflowError):
                self.send_error(400, "Invalid JSON body or TTL")
                return
            status, response = self.server.store.operate("PUT", key, body["value"], ttl)
        elif path == "/health":
            status, response = 200, {"status": "ok"}
        else:
            status, response = self.server.store.operate("KEYS" if path == "/v1/keys" else self.command, key)
        self.send_json(status, response)

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
    server = None
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
        server.store = store
        stopping = threading.Event()

        def stop(signum, frame):
            if not stopping.is_set():
                stopping.set()
                threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        print(f"LISTENING {server.server_port}", flush=True)
        server.serve_forever(poll_interval=0.1)
    except (OSError, ValueError) as error:
        print(f"Startup failed: {error}", file=sys.stderr)
        return 1
    finally:
        if server is not None:
            server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
