#!/usr/bin/env python3
"""A small persistent JSON key-value HTTP service (Python 3.11+ only)."""

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
from urllib.parse import urlsplit, unquote_to_bytes


MAX_BODY_BYTES = 1024 * 1024


class PersistenceError(RuntimeError):
    pass


class Store:
    """A lock-protected store whose on-disk representation contains only live data."""

    def __init__(self, filename: str) -> None:
        self.path = Path(filename)
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source)
            raw_entries = document["entries"]
            if not isinstance(raw_entries, dict):
                raise ValueError("entries is not an object")
            now = time.time()
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError("invalid entry")
                if set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid entry fields")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiration")
                if expires_at is None or expires_at > now:
                    self.entries[key] = entry
            # Rewrite if expiration removed items, so they never return after restart.
            if len(self.entries) != len(raw_entries):
                self._save_locked()
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, PersistenceError) as exc:
            print(f"warning: unable to load data file {self.path}: {exc}; starting empty", file=sys.stderr)
            self.entries = {}

    def _save_locked(self) -> None:
        """Atomically replace the state file. Caller holds self.lock."""
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as temporary:
                    json.dump({"entries": self.entries}, temporary, ensure_ascii=False,
                              allow_nan=False, separators=(",", ":"))
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_name, self.path)
                # Make replacement durable where the platform supports directory fsync.
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    pass
            except Exception:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except OSError as exc:
            raise PersistenceError(str(exc)) from exc

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items()
                   if entry["expires_at"] is not None and entry["expires_at"] <= now]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _purge_and_save_locked(self) -> None:
        if self._purge_locked():
            self._save_locked()

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self.lock:
            self._purge_and_save_locked()
            created = key not in self.entries
            old = self.entries.get(key)
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl_seconds is None else time.time() + ttl_seconds,
            }
            try:
                self._save_locked()
            except PersistenceError:
                if old is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = old
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._purge_and_save_locked()
            entry = self.entries.get(key)
            return (entry is not None, None if entry is None else entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_and_save_locked()
            if key not in self.entries:
                return False
            old = self.entries.pop(key)
            try:
                self._save_locked()
            except PersistenceError:
                self.entries[key] = old
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._purge_and_save_locked()
            return sorted(self.entries)


def decode_key(encoded: str) -> str:
    if not encoded or "/" in encoded:
        raise ValueError("key must be a non-empty single path segment")
    try:
        key = unquote_to_bytes(encoded).decode("utf-8", "strict")
    except UnicodeDecodeError as exc:
        raise ValueError("key must be valid UTF-8") from exc
    if not key or "/" in key:
        raise ValueError("key must be non-empty and may not contain '/'")
    return key


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    store: Store

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.client_address[0]} - {format % args}", file=sys.stderr)

    def _json(self, status: int, body: Any | None = None) -> None:
        encoded = b"" if body is None else json.dumps(body, ensure_ascii=False,
                                                       allow_nan=False,
                                                       separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        """Keep even BaseHTTPRequestHandler's unknown-method response JSON."""
        if code == HTTPStatus.NOT_IMPLEMENTED:
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "unsupported method")
        else:
            self._error(code, message or HTTPStatus(code).phrase)

    def _key_for_path(self) -> str | None:
        path = urlsplit(self.path).path
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        try:
            return decode_key(path[len(prefix):])
        except ValueError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return None

    def _read_put_body(self) -> tuple[Any, float | None] | None:
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._error(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            return None
        try:
            size = int(content_length)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if size < 0:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if size > MAX_BODY_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            return None
        try:
            raw = self.rfile.read(size)
            document = json.loads(raw.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return None
        if not isinstance(document, dict) or "value" not in document or set(document) - {"value", "ttl_seconds"}:
            self._error(HTTPStatus.BAD_REQUEST, "body must be an object with value and optional ttl_seconds")
            return None
        ttl = document.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0
        ):
            self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be a finite number greater than zero")
            return None
        return document["value"], ttl

    def do_PUT(self) -> None:
        key = self._key_for_path()
        if key is None:
            if not urlsplit(self.path).path.startswith("/v1/kv/"):
                self._error(HTTPStatus.NOT_FOUND, "unknown route")
            return
        payload = self._read_put_body()
        if payload is None:
            return
        try:
            created = self.store.put(key, *payload)
        except PersistenceError as exc:
            print(f"persistence error: {exc}", file=sys.stderr)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "unable to persist data")
            return
        self._json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": payload[0]})

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            self._json(HTTPStatus.OK, {"status": "ok"})
            return
        if path == "/v1/keys":
            try:
                self._json(HTTPStatus.OK, {"keys": self.store.keys()})
            except PersistenceError as exc:
                print(f"persistence error: {exc}", file=sys.stderr)
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "unable to persist data")
            return
        key = self._key_for_path()
        if key is None:
            if not path.startswith("/v1/kv/"):
                self._error(HTTPStatus.NOT_FOUND, "unknown route")
            return
        try:
            found, value = self.store.get(key)
        except PersistenceError as exc:
            print(f"persistence error: {exc}", file=sys.stderr)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "unable to persist data")
            return
        if not found:
            self._error(HTTPStatus.NOT_FOUND, "key not found")
        else:
            self._json(HTTPStatus.OK, {"key": key, "value": value})

    def do_DELETE(self) -> None:
        key = self._key_for_path()
        if key is None:
            if not urlsplit(self.path).path.startswith("/v1/kv/"):
                self._error(HTTPStatus.NOT_FOUND, "unknown route")
            return
        try:
            deleted = self.store.delete(key)
        except PersistenceError as exc:
            print(f"persistence error: {exc}", file=sys.stderr)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "unable to persist data")
            return
        if deleted:
            self._json(HTTPStatus.NO_CONTENT)
        else:
            self._error(HTTPStatus.NOT_FOUND, "key not found")

    def _unsupported(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "unsupported method")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")

    Handler.store = Store(args.data)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True

    def stop(_signum: int, _frame: Any) -> None:
        print("received termination signal", file=sys.stderr)
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {httpd.server_address[1]}", flush=True)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
