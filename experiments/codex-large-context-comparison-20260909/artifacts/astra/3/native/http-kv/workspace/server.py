#!/usr/bin/env python3
"""A small persistent, thread-safe HTTP key-value service (Python 3.11+)."""

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
    raise ValueError(f"Invalid JSON number: {value}")


def parse_json(raw):
    return json.loads(raw.decode("utf-8"), parse_constant=reject_constant)


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8")
    except UnicodeError:
        return False
    return True


def finite_number(value):
    try:
        return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
    except OverflowError:
        return False


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            data = parse_json(self.path.read_bytes())
            if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("entries"), dict):
                raise ValueError("Invalid data file")
            for key, entry in data["entries"].items():
                if not valid_key(key) or not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("Invalid persisted entry")
                expiry = entry["expires_at"]
                if expiry is not None and not finite_number(expiry):
                    raise ValueError("Invalid persisted expiry")
            self.entries = self.live(data["entries"])
            self.persist(self.entries)

    @staticmethod
    def live(entries):
        now = time.time()
        return {key: entry for key, entry in entries.items()
                if entry["expires_at"] is None or entry["expires_at"] > now}

    def persist(self, entries):
        # The temporary file is on the same filesystem as the destination.
        payload = json.dumps({"version": 1, "entries": entries}, allow_nan=False).encode("utf-8")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=".kv-", delete=False) as stream:
                temporary = stream.name
                stream.write(payload)
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
            if method == "keys":
                return 200, {"keys": sorted(entries)}
            if method == "GET":
                return (200, {"key": key, "value": entries[key]["value"]}) if present else (404, {"error": "Key not found"})
            if method == "DELETE" and not present:
                return 404, {"error": "Key not found"}
            if method == "PUT":
                expiry = None if ttl is None else time.time() + ttl
                if expiry is not None and not finite_number(expiry):
                    return 400, {"error": "TTL is too large"}
                entries[key] = {"value": value, "expires_at": expiry}
                result = (200 if present else 201), {"key": key, "value": value}
            else:
                del entries[key]
                result = 204, None
            # Commit memory only after the file replacement succeeds.
            self.persist(entries)
            self.entries = entries
            return result


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def respond(self, status, body):
        payload = b"" if body is None else json.dumps(body, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.respond(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def __getattr__(self, name):
        # BaseHTTPRequestHandler dispatches arbitrary HTTP verbs through do_*.
        if name.startswith("do_"):
            return self.handle_api
        raise AttributeError(name)

    def handle_api(self):
        try:
            self.dispatch()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except TimeoutError:
            self.send_error(408, "Request timed out")
        except (ValueError, UnicodeError, RecursionError, OverflowError):
            self.send_error(400, "Invalid JSON or request")
        except OSError as exc:
            self.log_error("Storage or connection failure: %s", exc)
            self.send_error(500, "Storage or connection failure")

    def dispatch(self):
        if self.headers.get("Transfer-Encoding") is not None:
            self.send_error(400, "Transfer-Encoding is not supported")
            return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
            self.send_error(400, "Invalid Content-Length")
            return
        length = int(lengths[0]) if lengths else 0
        if length > MAX_BODY:
            self.send_error(413, "Request body exceeds 1 MiB")
            return
        path = urlsplit(self.path).path
        key = None
        if path.startswith("/v1/kv/"):
            encoded = path[len("/v1/kv/"):]
            if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
                self.send_error(400, "Invalid key encoding")
                return
            key = unquote_to_bytes(encoded).decode("utf-8")
            if not valid_key(key):
                self.send_error(400, "Invalid key")
                return
            allowed = {"GET", "PUT", "DELETE"}
        elif path in {"/health", "/v1/keys"}:
            allowed = {"GET"}
        else:
            self.send_error(404, "Unknown route")
            return
        if self.command not in allowed:
            self.send_error(405, "Method not allowed")
            return
        raw = self.rfile.read(length)
        if len(raw) != length:
            self.send_error(400, "Incomplete request body")
            return
        body = parse_json(raw) if raw else None
        if self.command == "PUT":
            if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                self.send_error(400, "Expected value and optional ttl_seconds")
                return
            ttl = body.get("ttl_seconds")
            if "ttl_seconds" in body and (not finite_number(ttl) or ttl <= 0):
                self.send_error(400, "TTL must be finite and greater than zero")
                return
            # Also reject overflowed JSON numbers nested inside the value.
            json.dumps(body["value"], allow_nan=False)
            status, result = self.server.store.operate("PUT", key, body["value"], ttl)
        elif path == "/health":
            status, result = 200, {"status": "ok"}
        elif path == "/v1/keys":
            status, result = self.server.store.operate("keys")
        else:
            status, result = self.server.store.operate(self.command, key)
        self.respond(status, result)


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
    except (OSError, ValueError) as exc:
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
