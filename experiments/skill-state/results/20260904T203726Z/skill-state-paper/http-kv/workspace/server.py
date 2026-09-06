#!/usr/bin/env python3
"""A small persistent JSON key-value HTTP service."""

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


MAX_BODY = 1024 * 1024


class Store:
    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self.lock = threading.RLock()
        self.values: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        try:
            with self.path.open(encoding="utf-8") as file:
                loaded = json.load(file)
            if not isinstance(loaded, dict):
                raise ValueError("root is not an object")
            self.values = {
                key: entry for key, entry in loaded.items()
                if isinstance(key, str) and isinstance(entry, dict) and "value" in entry
                and (entry.get("expires_at") is None or isinstance(entry["expires_at"], (int, float)))
            }
        except FileNotFoundError:
            return
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"Unable to load data file: {exc}", file=sys.stderr)
        with self.lock:
            if self._purge_expired_locked():
                self._save_locked()

    def _purge_expired_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.values.items()
                   if entry.get("expires_at") is not None and entry["expires_at"] <= now]
        for key in expired:
            del self.values[key]
        return bool(expired)

    def _save_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent, text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(self.values, file, ensure_ascii=False, separators=(",", ":"))
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        except Exception:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def get(self, key: str):
        with self.lock:
            if self._purge_expired_locked():
                self._save_locked()
            entry = self.values.get(key)
            return None if entry is None else entry["value"]

    def put(self, key: str, value, ttl_seconds):
        with self.lock:
            self._purge_expired_locked()
            exists = key in self.values
            self.values[key] = {
                "value": value,
                "expires_at": None if ttl_seconds is None else time.time() + ttl_seconds,
            }
            self._save_locked()
            return exists

    def delete(self, key: str) -> bool:
        with self.lock:
            changed = self._purge_expired_locked()
            if key not in self.values:
                if changed:
                    self._save_locked()
                return False
            del self.values[key]
            self._save_locked()
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_expired_locked():
                self._save_locked()
            return sorted(self.values)


class Handler(BaseHTTPRequestHandler):
    store: Store

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _json(self, status: int, body=None) -> None:
        data = b"" if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _key(self):
        prefix = "/v1/kv/"
        if not self.path.startswith(prefix):
            return None
        encoded = self.path[len(prefix):]
        if "?" in encoded or not encoded:
            return None
        try:
            key = unquote(encoded, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        return key if key and "/" not in key else None

    def _read_json(self):
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            self._error(411, "Content-Length is required")
            return None
        try:
            length = int(length_header)
        except ValueError:
            self._error(400, "invalid Content-Length")
            return None
        if length < 0 or length > MAX_BODY:
            self._error(413, "request body too large")
            return None
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "malformed JSON")
            return None
        return value

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"status": "ok"})
        elif self.path == "/v1/keys":
            self._json(200, {"keys": self.store.keys()})
        elif (key := self._key()) is not None:
            value = self.store.get(key)
            if value is None:
                self._error(404, "key not found")
            else:
                self._json(200, {"key": key, "value": value})
        else:
            self._error(404, "unknown route")

    def do_PUT(self) -> None:
        key = self._key()
        if key is None:
            self._error(400, "invalid key or route")
            return
        payload = self._read_json()
        if payload is None:
            return
        if not isinstance(payload, dict) or "value" not in payload or set(payload) - {"value", "ttl_seconds"}:
            self._error(400, "body must contain value and optional ttl_seconds")
            return
        ttl = payload.get("ttl_seconds")
        if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        replaced = self.store.put(key, payload["value"], ttl)
        self._json(200 if replaced else 201, {"key": key, "value": payload["value"]})

    def do_DELETE(self) -> None:
        key = self._key()
        if key is None:
            self._error(400, "invalid key or route")
        elif self.store.delete(key):
            self._json(204)
        else:
            self._error(404, "key not found")

    def do_POST(self) -> None:
        self._error(405, "method not allowed")

    do_PATCH = do_POST
    do_HEAD = do_POST
    do_OPTIONS = do_POST


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    Handler.store = Store(args.data)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"LISTENING {server.server_port}", flush=True)

    def stop(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
