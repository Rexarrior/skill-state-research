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
from urllib.parse import unquote, urlsplit

MAX_BODY = 1024 * 1024


def reject_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def encode(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")


def live(entries):
    now = time.time()
    return {key: entry for key, entry in entries.items()
            if entry["expires_at"] is None or entry["expires_at"] > now}


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8"), parse_constant=reject_constant)
            if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("entries"), dict):
                raise ValueError("Invalid data file")
            for key, entry in data["entries"].items():
                if not key or "/" in key or not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("Invalid stored entry")
                key.encode("utf-8")
                expiry = entry["expires_at"]
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError("Invalid stored expiry")
            self.entries = live(data["entries"])
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.persist(self.entries)

    def persist(self, entries):
        payload = encode({"version": 1, "entries": entries})
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=self.path.name + ".", suffix=".tmp", delete=False) as output:
                temporary = output.name
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    def execute(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = live(self.entries)
            present = key in entries
            if method == "PUT":
                expiry = None if ttl is None else time.time() + ttl
                if expiry is not None and not math.isfinite(expiry):
                    raise ValueError("TTL produces an invalid expiration")
                entries[key] = {"value": value, "expires_at": expiry}
                self.persist(entries)
                self.entries = entries
                return (200 if present else 201), {"key": key, "value": value}
            if method == "DELETE" and present:
                del entries[key]
                self.persist(entries)
                self.entries = entries
                return 204, None
            self.entries = entries
            if method == "KEYS":
                return 200, {"keys": sorted(entries)}
            if method == "GET" and present:
                return 200, {"key": key, "value": entries[key]["value"]}
            return 404, {"error": "Key not found"}


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


class Handler(BaseHTTPRequestHandler):
    # Close each connection to avoid ambiguous framing and idle keep-alive clients.
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def reply(self, status, body, headers=None):
        payload = b"" if status == 204 else encode(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"error": message or self.responses.get(code, ("Request error",))[0]})

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.handle_api
        raise AttributeError(name)

    def handle_api(self):
        try:
            self.dispatch()
        except (ValueError, UnicodeError, RecursionError, OverflowError) as exc:
            self.reply(400, {"error": str(exc) or "Invalid request"})
        except (TimeoutError, ConnectionError):
            self.close_connection = True
        except OSError as exc:
            self.log_error("Storage or connection error: %s", exc)
            self.reply(500, {"error": "Storage unavailable"})

    def dispatch(self):
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") is not None:
            self.reply(400, {"error": "Transfer-Encoding is unsupported"})
            return
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
            raise ValueError("Invalid Content-Length")
        length = int(lengths[0]) if lengths else 0
        if length > MAX_BODY:
            self.reply(413, {"error": "Request body exceeds 1 MiB"})
            self.wfile.flush()
            # Allow an in-flight upload to finish so closing the socket does
            # not hide the error behind a TCP reset. Bound both time and bytes.
            remaining = min(length, 8 * MAX_BODY)
            deadline = time.monotonic() + 1
            while remaining and time.monotonic() < deadline:
                self.connection.settimeout(max(0.001, deadline - time.monotonic()))
                try:
                    chunk = self.rfile.read1(min(65536, remaining))
                except (TimeoutError, ConnectionError):
                    break
                if not chunk:
                    break
                remaining -= len(chunk)
            return
        path = urlsplit(self.path).path
        key = None
        if path in ("/health", "/v1/keys"):
            allowed = ("GET",)
        elif path.startswith("/v1/kv/"):
            raw_key = path[len("/v1/kv/"):]
            if re.search(r"%(?![0-9a-fA-F]{2})", raw_key):
                raise ValueError("Invalid percent encoding")
            key = unquote(raw_key, encoding="utf-8", errors="strict")
            key.encode("utf-8")
            if not key or "/" in key:
                raise ValueError("Invalid key")
            allowed = ("GET", "PUT", "DELETE")
        else:
            self.reply(404, {"error": "Unknown route"})
            return
        if self.command not in allowed:
            self.reply(405, {"error": "Method not allowed"}, {"Allow": ", ".join(allowed)})
            return
        value = ttl = None
        if length or self.command == "PUT":
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete request body")
            body = json.loads(raw.decode("utf-8"), parse_constant=reject_constant)
            # Reject numbers that overflow to infinity even inside arbitrary values.
            encode(body)
            if self.command == "PUT":
                if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                    raise ValueError("Expected value and optional ttl_seconds")
                value = body["value"]
                if "ttl_seconds" in body:
                    ttl = body["ttl_seconds"]
                    if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0:
                        raise ValueError("ttl_seconds must be finite and greater than zero")
        if path == "/health":
            self.reply(200, {"status": "ok"})
        else:
            method = "KEYS" if path == "/v1/keys" else self.command
            status, result = self.server.store.execute(method, key, value, ttl)
            self.reply(status, result)


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
    print(f"LISTENING {server.server_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        with store.lock:
            store.persist(live(store.entries))
    return 0


if __name__ == "__main__":
    sys.exit(main())
