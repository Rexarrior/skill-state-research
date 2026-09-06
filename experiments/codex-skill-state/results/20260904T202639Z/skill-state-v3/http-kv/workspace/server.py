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


MAX_BODY_SIZE = 1024 * 1024
API_PREFIX = "/v1/kv/"


class StoreError(Exception):
    """Raised when persistent state cannot be read or written."""


class PersistentStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_expired(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is not None and expires_at <= now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._reject_constant)
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("invalid top-level structure")

            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            expired_found = False
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not self.valid_key(key):
                    raise ValueError("invalid stored key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid stored entry")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid stored expiration")
                if self._is_expired(entry, now):
                    expired_found = True
                else:
                    loaded[key] = entry
            self.entries = loaded
            if expired_found:
                self._persist_locked()
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    @staticmethod
    def valid_key(key: str) -> bool:
        return bool(key) and "/" not in key

    def _persist_locked(self) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
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
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    def _prune_locked(self) -> bool:
        now = time.time()
        expired = [
            key for key, entry in self.entries.items() if self._is_expired(entry, now)
        ]
        for key in expired:
            del self.entries[key]
        if expired:
            self._persist_locked()
        return bool(expired)

    def put(self, key: str, value: Any, ttl_seconds: float | int | None) -> bool:
        with self.lock:
            self._prune_locked()
            created = key not in self.entries
            previous = self.entries.get(key)
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._prune_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._prune_locked()
            previous = self.entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist_locked()
            except StoreError:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._prune_locked()
            return sorted(self.entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: PersistentStore) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def __getattr__(self, name: str) -> Any:
        if name.startswith("do_"):
            return self._method_not_allowed
        raise AttributeError(name)

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - {format_string % args}",
            file=sys.stderr,
            flush=True,
        )

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        del explain
        self._send_json(code, {"error": message or HTTPStatus(code).phrase})

    def _send_json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _send_no_content(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _method_not_allowed(self) -> None:
        self._send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method not allowed"})

    def _route_path(self) -> str | None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return None
        return parsed.path

    def _key(self, path: str) -> str | None:
        if not path.startswith(API_PREFIX):
            return None
        encoded_key = path[len(API_PREFIX) :]
        if not encoded_key or "/" in encoded_key:
            return None
        try:
            key = unquote_to_bytes(encoded_key).decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError):
            return None
        return key if self.server.store.valid_key(key) else None

    def _read_json(self) -> Any:
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            raise RequestProblem(HTTPStatus.LENGTH_REQUIRED, "Content-Length required")
        try:
            length = int(content_length)
        except ValueError as exc:
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "invalid Content-Length") from exc
        if length < 0:
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        if length > MAX_BODY_SIZE:
            # Drain the rejected body without buffering it.  Closing a socket with
            # unread request bytes can cause the peer to observe a TCP reset and
            # lose the JSON 413 response entirely.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise RequestProblem(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body too large")
        body = self.rfile.read(length)
        if len(body) != length:
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "incomplete request body")
        try:
            return json.loads(body.decode("utf-8"), parse_constant=PersistentStore._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "malformed JSON") from exc

    def do_GET(self) -> None:
        path = self._route_path()
        if path == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
            return
        if path == "/v1/keys":
            try:
                self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            except StoreError as exc:
                self._internal_error(exc)
            return
        key = self._key(path) if path is not None else None
        if key is None:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            found, value = self.server.store.get(key)
        except StoreError as exc:
            self._internal_error(exc)
            return
        if not found:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "key not found"})
        else:
            self._send_json(HTTPStatus.OK, {"key": key, "value": value})

    def do_PUT(self) -> None:
        path = self._route_path()
        key = self._key(path) if path is not None else None
        if key is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid key or route"})
            return
        try:
            document = self._read_json()
            if (
                not isinstance(document, dict)
                or "value" not in document
                or not set(document).issubset({"value", "ttl_seconds"})
            ):
                raise RequestProblem(HTTPStatus.BAD_REQUEST, "invalid request shape")
            ttl = document.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestProblem(HTTPStatus.BAD_REQUEST, "invalid ttl_seconds")
            created = self.server.store.put(key, document["value"], ttl)
            self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key})
        except RequestProblem as exc:
            self._send_json(exc.status, {"error": exc.message})
        except StoreError as exc:
            self._internal_error(exc)

    def do_DELETE(self) -> None:
        path = self._route_path()
        key = self._key(path) if path is not None else None
        if key is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid key or route"})
            return
        try:
            if self.server.store.delete(key):
                self._send_no_content()
            else:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "key not found"})
        except StoreError as exc:
            self._internal_error(exc)

    def _internal_error(self, exc: Exception) -> None:
        print(f"storage error: {exc}", file=sys.stderr, flush=True)
        self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "storage error"})


class RequestProblem(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = PersistentStore(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup error: {exc}", file=sys.stderr, flush=True)
        return 1

    def stop(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    actual_port = server.server_address[1]
    print(f"LISTENING {actual_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
