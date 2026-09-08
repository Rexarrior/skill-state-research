#!/usr/bin/env python3
"""A small persistent HTTP key-value service."""

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
READ_ERROR = object()


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        with self._lock:
            if not self.path.exists():
                return
            try:
                with self.path.open("r", encoding="utf-8") as source:
                    document = json.load(source, parse_constant=self._invalid_constant)
                if not isinstance(document, dict) or document.get("version") != 1:
                    raise ValueError("unsupported data-file format")
                entries = document.get("entries")
                if not isinstance(entries, dict):
                    raise ValueError("data-file entries must be an object")

                loaded: dict[str, dict[str, Any]] = {}
                removed_expired = False
                now = time.time()
                for key, entry in entries.items():
                    if not isinstance(key, str) or not key or "/" in key:
                        raise ValueError("data file contains an invalid key")
                    if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                        raise ValueError("data file contains an invalid entry")
                    expires_at = entry["expires_at"]
                    if expires_at is not None:
                        if (isinstance(expires_at, bool) or
                                not isinstance(expires_at, (int, float)) or
                                (isinstance(expires_at, float) and
                                 not math.isfinite(expires_at))):
                            raise ValueError("data file contains an invalid expiration")
                        if expires_at <= now:
                            removed_expired = True
                            continue
                    loaded[key] = {"value": entry["value"], "expires_at": expires_at}
                self._entries = loaded
                if removed_expired:
                    self._persist_locked()
            except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
                raise StoreError(f"cannot load {self.path}: {exc}") from exc

    @staticmethod
    def _invalid_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _remove_expired_locked(self) -> bool:
        now = time.time()
        expired = [
            key for key, entry in self._entries.items()
            if entry["expires_at"] is not None and entry["expires_at"] <= now
        ]
        for key in expired:
            del self._entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                dir=parent, prefix=f".{self.path.name}.", suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as destination:
                    json.dump(
                        {"version": 1, "entries": self._entries},
                        destination,
                        ensure_ascii=True,
                        allow_nan=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                    destination.write("\n")
                    destination.flush()
                    os.fsync(destination.fileno())
                os.replace(temporary_name, self.path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    # Some filesystems do not permit fsync on directories.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass
                raise
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist {self.path}: {exc}") from exc

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            if self._remove_expired_locked():
                self._persist_locked()
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            return True, entry["value"]

    def put(self, key: str, value: Any, ttl_seconds: float | int | None) -> bool:
        with self._lock:
            self._remove_expired_locked()
            created = key not in self._entries
            previous = self._entries.get(key)
            if ttl_seconds is None:
                expires_at = None
            else:
                try:
                    expires_at = time.time() + ttl_seconds
                except OverflowError:
                    # Python JSON integers can exceed the range of a float.
                    # Retain such finite TTLs as an integer wall-clock deadline.
                    expires_at = math.ceil(time.time()) + ttl_seconds
            self._entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                if previous is None:
                    self._entries.pop(key, None)
                else:
                    self._entries[key] = previous
                raise
            return created

    def delete(self, key: str) -> bool:
        with self._lock:
            expired_removed = self._remove_expired_locked()
            previous = self._entries.pop(key, None)
            if previous is None:
                if expired_removed:
                    self._persist_locked()
                return False
            try:
                self._persist_locked()
            except StoreError:
                self._entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            if self._remove_expired_locked():
                self._persist_locked()
            return sorted(self._entries)

    def compact(self) -> None:
        with self._lock:
            if self._remove_expired_locked():
                self._persist_locked()


class KeyValueHandler(BaseHTTPRequestHandler):
    server_version = "http-kv/1"
    sys_version = ""

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined]

    def _send_json(self, status: int, document: Any, *, send_body: bool = True) -> None:
        encoded = json.dumps(
            document, ensure_ascii=True, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded) if send_body else 0))
        self.end_headers()
        if send_body:
            self.wfile.write(encoded)

    def _error(self, status: int, message: str, *, send_body: bool = True) -> None:
        self._send_json(status, {"error": message}, send_body=send_body)

    def _path(self) -> str | None:
        try:
            return urlsplit(self.path).path
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid request target")
            return None

    def _key(self, path: str) -> str | None:
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix):]
        # urllib deliberately leaves malformed percent escapes untouched, so
        # validate them before decoding.
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                if index + 2 >= len(encoded) or any(
                    char not in "0123456789abcdefABCDEF" for char in encoded[index + 1:index + 3]
                ):
                    self._error(HTTPStatus.BAD_REQUEST, "invalid URL encoding")
                    return None
                index += 3
            else:
                index += 1
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            self._error(HTTPStatus.BAD_REQUEST, "key must be valid UTF-8")
            return None
        if not key or "/" in key:
            self._error(HTTPStatus.BAD_REQUEST, "key must be non-empty and contain no slash")
            return None
        return key

    def _content_length(self) -> int | None:
        raw = self.headers.get("Content-Length")
        if raw is None:
            self._error(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            return None
        try:
            length = int(raw, 10)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length < 0:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length > MAX_BODY_BYTES:
            # Drain at most one byte beyond the accepted limit. This lets a
            # conventional client sending the boundary case receive the 413
            # instead of a TCP reset, without trusting an arbitrarily large
            # declared length.
            remaining = min(length, MAX_BODY_BYTES + 1)
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            return None
        return length

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "Transfer-Encoding is not supported")
            return READ_ERROR
        length = self._content_length()
        if length is None:
            return READ_ERROR
        body = self.rfile.read(length)
        if len(body) != length:
            self._error(HTTPStatus.BAD_REQUEST, "incomplete request body")
            return READ_ERROR
        try:
            return json.loads(body, parse_constant=Store._invalid_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return READ_ERROR

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        """Keep parser errors and unrecognized methods in the JSON API."""
        del explain
        if code == HTTPStatus.NOT_IMPLEMENTED:
            code = HTTPStatus.METHOD_NOT_ALLOWED
            message = "method not allowed"
        if message is None:
            try:
                message = HTTPStatus(code).phrase.lower()
            except ValueError:
                message = "request error"
        self._error(code, message, send_body=getattr(self, "command", None) != "HEAD")

    def do_GET(self) -> None:
        path = self._path()
        if path is None:
            return
        try:
            if path == "/health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._send_json(HTTPStatus.OK, {"keys": self.store.keys()})
                return
            if path.startswith("/v1/kv/"):
                key = self._key(path)
                if key is None:
                    return
                present, value = self.store.get(key)
                if not present:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
                    return
                self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                return
            self._error(HTTPStatus.NOT_FOUND, "route not found")
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def do_PUT(self) -> None:
        path = self._path()
        if path is None:
            return
        if not path.startswith("/v1/kv/"):
            self._error(HTTPStatus.NOT_FOUND, "route not found")
            return
        key = self._key(path)
        if key is None:
            return
        document = self._read_json()
        if document is READ_ERROR:
            return
        if not isinstance(document, dict) or "value" not in document:
            self._error(HTTPStatus.BAD_REQUEST, "body must be an object containing value")
            return
        if set(document) - {"value", "ttl_seconds"}:
            self._error(HTTPStatus.BAD_REQUEST, "body contains unknown fields")
            return
        ttl = document.get("ttl_seconds")
        ttl_is_invalid = (
            "ttl_seconds" in document
            and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or (isinstance(ttl, float) and not math.isfinite(ttl))
                or ttl <= 0
            )
        )
        if ttl_is_invalid:
            self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            created = self.store.put(key, document["value"], ttl)
            self._send_json(
                HTTPStatus.CREATED if created else HTTPStatus.OK,
                {"key": key, "value": document["value"]},
            )
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def do_DELETE(self) -> None:
        path = self._path()
        if path is None:
            return
        if not path.startswith("/v1/kv/"):
            self._error(HTTPStatus.NOT_FOUND, "route not found")
            return
        key = self._key(path)
        if key is None:
            return
        try:
            if not self.store.delete(key):
                self._error(HTTPStatus.NOT_FOUND, "key not found")
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def _method_not_allowed(self, *, send_body: bool = True) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed", send_body=send_body)

    def do_POST(self) -> None:
        self._method_not_allowed()

    def do_PATCH(self) -> None:
        self._method_not_allowed()

    def do_OPTIONS(self) -> None:
        self._method_not_allowed()

    def do_TRACE(self) -> None:
        self._method_not_allowed()

    def do_CONNECT(self) -> None:
        self._method_not_allowed()

    def do_HEAD(self) -> None:
        self._method_not_allowed(send_body=False)

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - - [{self.log_date_time_string()}] {format % args}",
            file=sys.stderr,
            flush=True,
        )


class KeyValueServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, KeyValueHandler)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int, choices=range(0, 65536))
    parser.add_argument("--data", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        store = Store(args.data)
        server = KeyValueServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup error: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, name="server-shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    exit_code = 0
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        try:
            store.compact()
        except StoreError as exc:
            print(f"shutdown error: {exc}", file=sys.stderr, flush=True)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
