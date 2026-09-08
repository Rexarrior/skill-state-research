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


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            document = decode_json(self.path.read_text(encoding="utf-8"))
            if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("entries"), dict):
                raise ValueError("Invalid persistence file")
            for key, entry in document["entries"].items():
                if not valid_key(key) or not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("Invalid persisted entry")
                expiry = entry.get("expires_at")
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError("Invalid persisted expiration")
                encode_json(entry["value"])
            self.entries = self.live(document["entries"])
            self.persist(self.entries)

    @staticmethod
    def live(entries):
        now = time.time()
        return {key: entry for key, entry in entries.items()
                if entry.get("expires_at") is None or entry["expires_at"] > now}

    def persist(self, entries):
        data = encode_json({"version": 1, "entries": entries})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix="." + self.path.name + ".", delete=False) as file:
                name = file.name
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live(self.entries)
            if method == "keys":
                return 200, {"keys": sorted(entries)}
            if method == "GET":
                if key not in entries:
                    return 404, {"error": "Key not found"}
                return 200, {"key": key, "value": entries[key]["value"]}
            if method == "DELETE":
                if key not in entries:
                    return 404, {"error": "Key not found"}
                del entries[key]
                status, body = 204, None
            else:
                status = 200 if key in entries else 201
                entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
                body = {"key": key, "value": value}
            self.persist(entries)
            self.entries = entries
            return status, body


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8")
        return True
    except UnicodeError:
        return False


class Handler(BaseHTTPRequestHandler):
    # A connection handles one request, including on errors with unread bodies.
    protocol_version = "HTTP/1.0"

    def reply(self, status, body):
        data = b"" if body is None else encode_json(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        self.close_connection = True

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.handle_api
        raise AttributeError(name)

    def handle_api(self):
        try:
            self.dispatch()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.log_error("Request failed: %s", exc)
            self.reply(500, {"error": "Internal server error"})

    def dispatch(self):
        if self.headers.get("Transfer-Encoding") is not None:
            self.reply(400, {"error": "Transfer-Encoding is not supported"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
            self.reply(400, {"error": "Invalid Content-Length"})
            return
        try:
            length = int(lengths[0]) if lengths else 0
        except ValueError:
            self.reply(413, {"error": "Request body exceeds 1 MiB"})
            return
        if length > MAX_BODY:
            self.reply(413, {"error": "Request body exceeds 1 MiB"})
            return
        try:
            path = urlsplit(self.path).path
        except ValueError:
            self.reply(400, {"error": "Invalid URL"})
            return
        key = None
        if path.startswith("/v1/kv/"):
            encoded = path[len("/v1/kv/"):]
            try:
                if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
                    raise ValueError("Invalid escape")
                key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
                if not valid_key(key):
                    raise ValueError("Invalid key")
            except (UnicodeError, ValueError):
                self.reply(400, {"error": "Invalid key"})
                return
            allowed = ("GET", "PUT", "DELETE")
        elif path in ("/health", "/v1/keys"):
            allowed = ("GET",)
        else:
            self.reply(404, {"error": "Unknown route"})
            return
        if self.command not in allowed:
            self.reply(405, {"error": "Method not allowed"})
            return
        if self.command == "PUT":
            if not lengths:
                self.reply(411, {"error": "Content-Length required"})
                return
            try:
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("Incomplete body")
                body = decode_json(raw.decode("utf-8"))
                if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                    raise ValueError("Expected value and optional ttl_seconds")
                encode_json(body["value"])
                ttl = body.get("ttl_seconds")
                if "ttl_seconds" in body:
                    if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
                        raise ValueError("TTL must be finite and positive")
            except (ValueError, UnicodeError, OverflowError, RecursionError) as exc:
                self.reply(400, {"error": str(exc)})
                return
            self.reply(*self.server.store.operate("PUT", key, body["value"], ttl))
        elif path == "/health":
            self.reply(200, {"status": "ok"})
        elif path == "/v1/keys":
            self.reply(*self.server.store.operate("keys"))
        else:
            self.reply(*self.server.store.operate(self.command, key))

    def setup(self):
        super().setup()
        self.connection.settimeout(5)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
        server.store = store
    except (OSError, ValueError, OverflowError, RecursionError) as exc:
        print(f"Startup failed: {exc}", file=sys.stderr)
        return 1
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
