#!/usr/bin/env python3
"""Persistent HTTP key-value service using only the Python standard library."""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote


MAX_BODY_SIZE = 1024 * 1024


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        try:
            with self.path.open(encoding="utf-8") as data_file:
                loaded = json.load(data_file)
            if not isinstance(loaded, dict):
                raise ValueError("top-level JSON value must be an object")
            self.entries = {
                key: entry
                for key, entry in loaded.items()
                if isinstance(key, str)
                and isinstance(entry, dict)
                and "value" in entry
                and (entry.get("expires_at") is None or isinstance(entry["expires_at"], (int, float)))
            }
        except FileNotFoundError:
            return
        except (OSError, ValueError, json.JSONDecodeError) as error:
            print(f"warning: could not load {self.path}: {error}", file=sys.stderr, flush=True)
            return
        self._purge_expired(persist=True)

    def _purge_expired(self, persist: bool = False) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items()
                   if entry.get("expires_at") is not None and entry["expires_at"] <= now]
        for key in expired:
            del self.entries[key]
        if expired and persist:
            self._save()
        return bool(expired)

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent, text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as temporary_file:
                json.dump(self.entries, temporary_file, ensure_ascii=False, separators=(",", ":"))
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.replace(temporary_name, self.path)
        except Exception:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_expired()
            created = key not in self.entries
            self.entries[key] = {"value": value, "expires_at": time.time() + ttl if ttl is not None else None}
            self._save()
            return created

    def get(self, key: str) -> Any | None:
        with self.lock:
            if self._purge_expired(persist=True):
                pass
            entry = self.entries.get(key)
            return None if entry is None else entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_expired()
            if key not in self.entries:
                return False
            del self.entries[key]
            self._save()
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._purge_expired(persist=True)
            return sorted(self.entries)


def parse_key(path: str) -> str | None:
    prefix = "/v1/kv/"
    if not path.startswith(prefix):
        return None
    encoded = path[len(prefix):]
    if not encoded or "/" in encoded:
        return None
    try:
        key = unquote(encoded, encoding="utf-8", errors="strict")
    except UnicodeDecodeError:
        return None
    return key if key and "/" not in key else None


class Handler(BaseHTTPRequestHandler):
    store: Store
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.client_address[0]} - {format % args}", file=sys.stderr, flush=True)

    def _json(self, status: int, payload: Any | None = None) -> None:
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        if payload is not None:
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _key(self) -> str | None:
        key = parse_key(self.path.split("?", 1)[0])
        if key is None:
            self._error(HTTPStatus.BAD_REQUEST, "invalid key or route")
        return key

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._json(HTTPStatus.OK, {"status": "ok"})
        elif path == "/v1/keys":
            self._json(HTTPStatus.OK, {"keys": self.store.keys()})
        elif (key := self._key()) is not None:
            value = self.store.get(key)
            if value is None and key not in self.store.entries:
                self._error(HTTPStatus.NOT_FOUND, "key not found")
            else:
                self._json(HTTPStatus.OK, {"key": key, "value": value})

    def do_DELETE(self) -> None:
        key = self._key()
        if key is not None:
            if self.store.delete(key):
                self._json(HTTPStatus.NO_CONTENT)
            else:
                self._error(HTTPStatus.NOT_FOUND, "key not found")

    def do_PUT(self) -> None:
        key = self._key()
        if key is None:
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
            if length < 0 or length > MAX_BODY_SIZE:
                raise ValueError
        except ValueError:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return
        if not isinstance(payload, dict) or "value" not in payload or set(payload) - {"value", "ttl_seconds"}:
            self._error(HTTPStatus.BAD_REQUEST, "body must contain value and optional ttl_seconds")
            return
        ttl = payload.get("ttl_seconds")
        if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0):
            self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be a finite positive number")
            return
        try:
            created = self.store.put(key, payload["value"], ttl)
        except (OSError, TypeError, ValueError) as error:
            print(f"error: persistence failed: {error}", file=sys.stderr, flush=True)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not persist value")
            return
        self._json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": payload["value"]})

    def do_POST(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    def do_PATCH(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    def do_HEAD(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True, type=Path)
    args = parser.parse_args()
    Handler.store = Store(args.data)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True

    def stop(signum: int, frame: Any) -> None:
        print("received shutdown signal", file=sys.stderr, flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    print(f"LISTENING {server.server_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
