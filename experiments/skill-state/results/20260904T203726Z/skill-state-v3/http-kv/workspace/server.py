#!/usr/bin/env python3
"""A small persistent HTTP key-value service."""

import argparse
import json
import math
import os
import signal
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


MAX_BODY_SIZE = 1024 * 1024


class Store:
    def __init__(self, data_path):
        self.path = Path(data_path)
        self.lock = threading.RLock()
        self.entries = {}
        self._load()

    @staticmethod
    def _live(entry, now=None):
        expires_at = entry.get("expires_at")
        return expires_at is None or expires_at > (time.time() if now is None else now)

    def _purge_expired(self):
        expired = [key for key, entry in self.entries.items() if not self._live(entry)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _load(self):
        if not self.path.exists():
            return
        try:
            with self.path.open(encoding="utf-8") as data_file:
                raw = json.load(data_file)
            if not isinstance(raw, dict):
                raise ValueError("top-level value is not an object")
            for key, entry in raw.items():
                if (isinstance(key, str) and isinstance(entry, dict)
                        and "value" in entry and entry.get("expires_at") is None or
                        isinstance(key, str) and isinstance(entry, dict) and "value" in entry
                        and isinstance(entry.get("expires_at"), (int, float))):
                    self.entries[key] = entry
            if self._purge_expired():
                self._save()
        except (OSError, ValueError, json.JSONDecodeError) as error:
            print(f"Unable to load data file: {error}", file=sys.stderr)

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        live = {key: value for key, value in self.entries.items() if self._live(value)}
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent, text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as data_file:
                json.dump(live, data_file, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                data_file.flush()
                os.fsync(data_file.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def get(self, key):
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return None
            if not self._live(entry):
                del self.entries[key]
                self._save()
                return None
            return entry["value"]

    def put(self, key, value, ttl):
        with self.lock:
            existed = self.get(key) is not None
            self.entries[key] = {"value": value, "expires_at": time.time() + ttl if ttl else None}
            self._save()
            return existed

    def delete(self, key):
        with self.lock:
            if self.get(key) is None:
                return False
            del self.entries[key]
            self._save()
            return True

    def keys(self):
        with self.lock:
            if self._purge_expired():
                self._save()
            return sorted(self.entries)


class Handler(BaseHTTPRequestHandler):
    store = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"{self.client_address[0]} - {fmt % args}", file=sys.stderr)

    def respond(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        if payload is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def error(self, status, message):
        self.respond(status, {"error": message})

    def key_from_path(self):
        prefix = "/v1/kv/"
        if not self.path.startswith(prefix):
            return None
        encoded = self.path[len(prefix):].split("?", 1)[0]
        try:
            key = unquote(encoded, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        return key if key and "/" not in key else None

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/health":
            return self.respond(200, {"status": "ok"})
        if self.path.split("?", 1)[0] == "/v1/keys":
            return self.respond(200, {"keys": self.store.keys()})
        key = self.key_from_path()
        if key is None:
            return self.error(404, "not found")
        value = self.store.get(key)
        if value is None:
            return self.error(404, "key not found")
        self.respond(200, {"key": key, "value": value})

    def do_DELETE(self):
        key = self.key_from_path()
        if key is None:
            return self.error(404, "not found")
        if not self.store.delete(key):
            return self.error(404, "key not found")
        self.respond(204)

    def do_PUT(self):
        key = self.key_from_path()
        if key is None:
            return self.error(400, "invalid key")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.error(400, "invalid Content-Length")
        if length < 0 or length > MAX_BODY_SIZE:
            return self.error(413, "request body too large")
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self.error(400, "malformed JSON")
        if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
            return self.error(400, "body must contain value and optional ttl_seconds")
        ttl = body.get("ttl_seconds")
        if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float))
                                or not math.isfinite(ttl) or ttl <= 0):
            return self.error(400, "ttl_seconds must be a finite positive number")
        try:
            replaced = self.store.put(key, body["value"], ttl)
        except (TypeError, ValueError):
            return self.error(400, "value is not JSON serializable")
        self.respond(200 if replaced else 201, {"key": key, "value": body["value"]})

    def do_POST(self):
        self.error(405, "method not allowed")

    def do_PATCH(self):
        self.error(405, "method not allowed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    Handler.store = Store(args.data)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"LISTENING {server.server_port}", flush=True)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
