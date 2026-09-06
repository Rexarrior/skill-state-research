#!/usr/bin/env python3
"""Persistent, dependency-free HTTP key-value service."""

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
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024


class Store:
    def __init__(self, path: str):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.entries = {}
        self._load()

    @staticmethod
    def _expired(entry):
        expiry = entry.get("expires_at")
        return expiry is not None and expiry <= time.time()

    def _load(self):
        try:
            with self.path.open("r", encoding="utf-8") as source:
                loaded = json.load(source)
            if not isinstance(loaded, dict) or not isinstance(loaded.get("entries", {}), dict):
                raise ValueError("expected object with an entries object")
            for key, entry in loaded["entries"].items():
                if isinstance(key, str) and isinstance(entry, dict) and "value" in entry:
                    expiry = entry.get("expires_at")
                    if expiry is None or (isinstance(expiry, (int, float)) and math.isfinite(expiry)):
                        self.entries[key] = {"value": entry["value"], "expires_at": expiry}
            if self._purge_expired():
                self._persist()
        except FileNotFoundError:
            pass
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"warning: could not load data file {self.path}: {exc}", file=sys.stderr, flush=True)

    def _purge_expired(self):
        expired = [key for key, entry in self.entries.items() if self._expired(entry)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"entries": self.entries}, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        fd, temp_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as target:
                target.write(payload)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temp_name, self.path)
        except Exception:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
            raise

    def put(self, key, value, ttl):
        with self.lock:
            self._purge_expired()
            existed = key in self.entries
            self.entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
            self._persist()
            return existed

    def get(self, key):
        with self.lock:
            if self._purge_expired():
                self._persist()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key):
        with self.lock:
            self._purge_expired()
            if key not in self.entries:
                return False
            del self.entries[key]
            self._persist()
            return True

    def keys(self):
        with self.lock:
            if self._purge_expired():
                self._persist()
            return sorted(self.entries)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    store = None

    def log_message(self, format, *args):
        print(f"{self.client_address[0]} - {format % args}", file=sys.stderr, flush=True)

    def _json(self, status, value=None):
        body = b"" if status == 204 else json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        if status != 204:
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, status, message):
        self._json(status, {"error": message})

    def _key(self):
        path = urlsplit(self.path).path
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix):]
        if not encoded or "/" in encoded:
            return None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            return None
        return key if key and "/" not in key else None

    def _body(self):
        header = self.headers.get("Content-Length")
        try:
            length = int(header) if header is not None else None
        except ValueError:
            length = None
        if length is None or length < 0:
            self._error(400, "valid Content-Length required")
            return None
        if length > MAX_BODY:
            self._error(413, "request body too large")
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "malformed JSON")
            return None

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            return self._json(200, {"status": "ok"})
        if path == "/v1/keys":
            return self._json(200, {"keys": self.store.keys()})
        key = self._key()
        if key is None:
            return self._error(404, "unknown route")
        found, value = self.store.get(key)
        if not found:
            return self._error(404, "key not found")
        return self._json(200, {"key": key, "value": value})

    def do_PUT(self):
        key = self._key()
        if key is None:
            return self._error(404, "unknown route")
        data = self._body()
        if data is None:
            return
        if not isinstance(data, dict) or "value" not in data or set(data) - {"value", "ttl_seconds"}:
            return self._error(400, "body must be an object with value and optional ttl_seconds")
        ttl = data.get("ttl_seconds")
        if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0):
            return self._error(400, "ttl_seconds must be a finite number greater than zero")
        try:
            existed = self.store.put(key, data["value"], ttl)
        except (OSError, TypeError, ValueError) as exc:
            print(f"persistence error: {exc}", file=sys.stderr, flush=True)
            return self._error(500, "could not persist data")
        self._json(200 if existed else 201, {"key": key, "value": data["value"]})

    def do_DELETE(self):
        key = self._key()
        if key is None:
            return self._error(404, "unknown route")
        try:
            deleted = self.store.delete(key)
        except OSError as exc:
            print(f"persistence error: {exc}", file=sys.stderr, flush=True)
            return self._error(500, "could not persist data")
        if not deleted:
            return self._error(404, "key not found")
        self._json(204)

    def do_POST(self): self._error(405, "method not allowed")
    def do_PATCH(self): self._error(405, "method not allowed")
    def do_HEAD(self): self._error(405, "method not allowed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    Handler.store = Store(args.data)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    stop = threading.Event()

    def shutdown(signum, frame):
        if not stop.is_set():
            stop.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    print(f"LISTENING {server.server_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
