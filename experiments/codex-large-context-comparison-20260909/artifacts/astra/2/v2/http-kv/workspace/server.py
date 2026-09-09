#!/usr/bin/env python3
"""Dependency-free persistent HTTP key-value service (Python 3.11+)."""
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


def strict_json(raw):
    def reject(value):
        raise ValueError(f"Invalid JSON number: {value}")
    return json.loads(raw, parse_constant=reject)


def encode(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            data = strict_json(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("entries"), dict):
                raise ValueError("Invalid persisted state")
            for key, entry in data["entries"].items():
                if not valid_key(key) or not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("Invalid persisted entry")
                expiry = entry["expires_at"]
                if expiry is not None and not finite_number(expiry):
                    raise ValueError("Invalid persisted expiration")
            encode(data)  # Reject out-of-range JSON numbers parsed as infinity.
            self.entries = self.live(data["entries"])
            if len(self.entries) != len(data["entries"]):
                self.persist(self.entries)

    @staticmethod
    def live(entries):
        now = time.time()
        return {key: entry for key, entry in entries.items()
                if entry["expires_at"] is None or entry["expires_at"] > now}

    def persist(self, entries):
        payload = encode({"version": 1, "entries": entries})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=f".{self.path.name}.", delete=False) as f:
                name = f.name
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            os.replace(name, self.path)
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)

    def execute(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live(self.entries)
            if method == "keys":
                result = (200, {"keys": sorted(entries)})
            elif method == "GET":
                result = ((200, {"key": key, "value": entries[key]["value"]}) if key in entries
                          else (404, {"error": "Key not found"}))
            elif method == "PUT":
                status = 200 if key in entries else 201
                entries[key] = {"value": value, "expires_at": time.time() + ttl if ttl is not None else None}
                result = (status, {"key": key, "value": value})
            else:
                result = (204, None) if key in entries else (404, {"error": "Key not found"})
                entries.pop(key, None)
            if method in ("PUT", "DELETE") or len(entries) != len(self.entries):
                self.persist(entries)
            self.entries = entries
            return result


def finite_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
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
    # One request per connection avoids unread bodies affecting later requests.
    protocol_version = "HTTP/1.0"

    def respond(self, status, body):
        payload = b"" if status == 204 else encode(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.respond(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.handle_api
        raise AttributeError(name)

    def handle_api(self):
        try:
            self.connection.settimeout(10)
            if self.headers.get("Transfer-Encoding") is not None:
                self.respond(400, {"error": "Transfer-Encoding is not supported"})
                return
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
                self.respond(400, {"error": "Invalid Content-Length"})
                return
            length = int(lengths[0]) if lengths else 0
            if length > MAX_BODY:
                self.respond(413, {"error": "Request body exceeds 1 MiB"})
                return
            if self.command not in ("GET", "PUT", "DELETE"):
                self.respond(405, {"error": "Unsupported method"})
                return
            path = urlsplit(self.path).path
            if path in ("/health", "/v1/keys"):
                if self.command != "GET":
                    self.respond(405, {"error": "Unsupported method"})
                elif path == "/health":
                    self.respond(200, {"status": "ok"})
                else:
                    self.respond(*self.server.store.execute("keys"))
                return
            if not path.startswith("/v1/kv/"):
                self.respond(404, {"error": "Unknown route"})
                return
            raw_key = path[len("/v1/kv/"):]
            if re.search(r"%(?![0-9a-fA-F]{2})", raw_key):
                raise ValueError("Invalid key encoding")
            key = unquote_to_bytes(raw_key).decode("utf-8", errors="strict")
            if not valid_key(key):
                raise ValueError("Invalid key")
            value, ttl = None, None
            if self.command == "PUT":
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("Incomplete request body")
                body = strict_json(raw.decode("utf-8"))
                if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                    raise ValueError("Expected an object with value and optional ttl_seconds")
                value = body["value"]
                encode(value)
                if "ttl_seconds" in body:
                    ttl = body["ttl_seconds"]
                    if not finite_number(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
                        raise ValueError("ttl_seconds must be finite and greater than zero")
            self.respond(*self.server.store.execute(self.command, key, value, ttl))
        except (ValueError, UnicodeError, OverflowError, RecursionError) as exc:
            self.respond(400, {"error": str(exc) or "Invalid request"})
        except TimeoutError:
            self.respond(408, {"error": "Request timed out"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as exc:
            print(f"Storage/request error: {exc}", file=sys.stderr, flush=True)
            self.respond(500, {"error": "Internal server error"})


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def get_request(self):
        conn, addr = super().get_request()
        conn.settimeout(10)
        return conn, addr


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
        server.store = store
    except (OSError, ValueError, RecursionError) as exc:
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
