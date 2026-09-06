#!/usr/bin/env python3
"""Persistent, dependency-free HTTP key-value service."""

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
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
KV_PREFIX = "/v1/kv/"


class Store:
    """Lock-protected store persisted by atomically replacing a JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _expired(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is not None and expires_at <= now

    def _remove_expired_locked(self, now: float) -> bool:
        expired = [
            key for key, entry in self.entries.items() if self._expired(entry, now)
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle)
            raw_entries = document.get("entries") if isinstance(document, dict) else None
            if not isinstance(raw_entries, dict):
                raise ValueError("data file must contain an entries object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError("data file contains an invalid entry")
                if "value" not in entry:
                    raise ValueError("data file entry has no value")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("data file entry has an invalid expiry")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
            if self._remove_expired_locked(time.time()):
                self._persist_locked()
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    {"entries": self.entries},
                    handle,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, self.path)
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except Exception:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._remove_expired_locked(now)
            created = key not in self.entries
            expires_at = None if ttl is None else now + ttl
            old_entry = self.entries.get(key)
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except Exception:
                if old_entry is None:
                    del self.entries[key]
                else:
                    self.entries[key] = old_entry
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if self._expired(entry, time.time()):
                del self.entries[key]
                self._persist_locked()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            now = time.time()
            self._remove_expired_locked(now)
            old_entry = self.entries.pop(key, None)
            if old_entry is None:
                return False
            try:
                self._persist_locked()
            except Exception:
                self.entries[key] = old_entry
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._remove_expired_locked(time.time()):
                self._persist_locked()
            return sorted(self.entries)


class KVHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        super().__init__(address, RequestHandler)
        self.store = store


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined, no-any-return]

    def log_message(self, fmt: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] {fmt % args}",
            file=sys.stderr,
        )

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _key(self) -> tuple[str | None, str | None]:
        path = self._path()
        if not path.startswith(KV_PREFIX):
            return None, "unknown route"
        encoded = path[len(KV_PREFIX) :]
        if not encoded or "/" in encoded:
            return None, "key must be non-empty and must not contain '/'"
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return None, "key must be valid UTF-8"
        if not key or "/" in key:
            return None, "key must be non-empty and must not contain '/'"
        return key, None

    def _read_json(self) -> tuple[Any | None, str | None, int | None]:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            return None, "Transfer-Encoding is not supported", HTTPStatus.BAD_REQUEST
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            return None, "Content-Length is required", HTTPStatus.LENGTH_REQUIRED
        try:
            length = int(length_header)
        except ValueError:
            return None, "invalid Content-Length", HTTPStatus.BAD_REQUEST
        if length < 0:
            return None, "invalid Content-Length", HTTPStatus.BAD_REQUEST
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            return None, "request body exceeds 1 MiB", HTTPStatus.REQUEST_ENTITY_TOO_LARGE
        raw = self.rfile.read(length)
        if len(raw) != length:
            return None, "incomplete request body", HTTPStatus.BAD_REQUEST
        try:
            return json.loads(raw), None, None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, "malformed JSON", HTTPStatus.BAD_REQUEST

    def _handle_storage_error(self, exc: Exception) -> None:
        print(f"storage error: {exc}", file=sys.stderr)
        self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def do_GET(self) -> None:
        path = self._path()
        try:
            if path == "/health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._send_json(HTTPStatus.OK, {"keys": self.store.keys()})
                return
            key, error = self._key()
            if error is not None:
                status = HTTPStatus.BAD_REQUEST if path.startswith(KV_PREFIX) else HTTPStatus.NOT_FOUND
                self._error(status, error)
                return
            found, value = self.store.get(key)
            if not found:
                self._error(HTTPStatus.NOT_FOUND, "key not found")
                return
            self._send_json(HTTPStatus.OK, {"key": key, "value": value})
        except OSError as exc:
            self._handle_storage_error(exc)

    def do_PUT(self) -> None:
        path = self._path()
        key, error = self._key()
        if error is not None:
            status = HTTPStatus.BAD_REQUEST if path.startswith(KV_PREFIX) else HTTPStatus.NOT_FOUND
            self._error(status, error)
            return
        document, error, status = self._read_json()
        if error is not None:
            self._error(status or HTTPStatus.BAD_REQUEST, error)
            return
        if not isinstance(document, dict) or "value" not in document:
            self._error(HTTPStatus.BAD_REQUEST, "body must be an object containing value")
            return
        if set(document) - {"value", "ttl_seconds"}:
            self._error(HTTPStatus.BAD_REQUEST, "body contains unsupported fields")
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.store.put(key, document["value"], ttl)
            self._send_json(
                HTTPStatus.CREATED if created else HTTPStatus.OK,
                {"key": key, "value": document["value"]},
            )
        except (OSError, ValueError, TypeError) as exc:
            self._handle_storage_error(exc)

    def do_DELETE(self) -> None:
        path = self._path()
        key, error = self._key()
        if error is not None:
            status = HTTPStatus.BAD_REQUEST if path.startswith(KV_PREFIX) else HTTPStatus.NOT_FOUND
            self._error(status, error)
            return
        try:
            if not self.store.delete(key):
                self._error(HTTPStatus.NOT_FOUND, "key not found")
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except OSError as exc:
            self._handle_storage_error(exc)

    def do_POST(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    def do_PATCH(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    def do_HEAD(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    def do_OPTIONS(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True, type=Path)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = Store(args.data)
        server = KVHTTPServer((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"startup error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
