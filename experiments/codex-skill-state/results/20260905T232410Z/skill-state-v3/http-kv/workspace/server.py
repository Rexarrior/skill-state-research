#!/usr/bin/env python3
"""A small persistent HTTP key-value service."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
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


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StorageError(Exception):
    """Raised when durable storage cannot be read or updated."""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_expired(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is not None and expires_at <= now

    def _pruned(self, entries: dict[str, dict[str, Any]], now: float) -> tuple[dict[str, dict[str, Any]], bool]:
        live = {key: entry for key, entry in entries.items() if not self._is_expired(entry, now)}
        return live, len(live) != len(entries)

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("expected a version 1 storage object")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("'entries' must be an object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("stored key is invalid")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("stored entry is invalid")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("stored expiration is invalid")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries, changed = self._pruned(loaded, time.time())
            if changed:
                self._write(self.entries)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StorageError(f"cannot load {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _write(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as target:
                    json.dump(
                        {"version": 1, "entries": entries},
                        target,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                    )
                    target.write("\n")
                    target.flush()
                    os.fsync(target.fileno())
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
                except OSError:
                    pass
                raise
        except (OSError, ValueError, TypeError) as exc:
            raise StorageError(f"cannot persist {self.path}: {exc}") from exc

    def _remove_expired(self) -> None:
        live, changed = self._pruned(self.entries, time.time())
        if changed:
            self._write(live)
            self.entries = live

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self.lock:
            self._remove_expired()
            created = key not in self.entries
            updated = dict(self.entries)
            updated[key] = {
                "value": value,
                "expires_at": None if ttl_seconds is None else time.time() + ttl_seconds,
            }
            self._write(updated)
            self.entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._remove_expired()
            if key not in self.entries:
                return False, None
            return True, self.entries[key]["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            self._remove_expired()
            if key not in self.entries:
                return False
            updated = dict(self.entries)
            del updated[key]
            self._write(updated)
            self.entries = updated
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._remove_expired()
            return sorted(self.entries)


class KeyValueServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KeyValueServer
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format_string % args}", file=sys.stderr, flush=True)

    def _send_json(self, status: int, payload: Any, headers: dict[str, str] | None = None) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        if headers:
            for name, value in headers.items():
                self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str, headers: dict[str, str] | None = None) -> None:
        self._send_json(status, {"error": message}, headers)

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _decode_key(self) -> str | None:
        path = self._path()
        if not path.startswith(KEY_PREFIX):
            self._error(HTTPStatus.NOT_FOUND, "unknown route")
            return None
        encoded_key = path[len(KEY_PREFIX):]
        if not encoded_key:
            self._error(HTTPStatus.BAD_REQUEST, "key must not be empty")
            return None
        if "/" in encoded_key or BAD_PERCENT_ESCAPE.search(encoded_key):
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            return None
        try:
            key = unquote_to_bytes(encoded_key).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            self._error(HTTPStatus.BAD_REQUEST, "key must be valid UTF-8")
            return None
        if not key or "/" in key:
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            return None
        return key

    def _read_json(self) -> Any | None:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
            return None
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._error(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            return None
        try:
            length = int(content_length, 10)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length < 0:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length > MAX_BODY:
            self.close_connection = True
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            return None
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "incomplete request body")
            return None
        try:
            return json.loads(body, parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return None

    def do_GET(self) -> None:
        path = self._path()
        try:
            if path == "/health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
            elif path == "/v1/keys":
                self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            elif path.startswith(KEY_PREFIX):
                key = self._decode_key()
                if key is None:
                    return
                found, value = self.server.store.get(key)
                if found:
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            else:
                self._error(HTTPStatus.NOT_FOUND, "unknown route")
        except StorageError as exc:
            print(exc, file=sys.stderr, flush=True)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage operation failed")

    def do_PUT(self) -> None:
        if not self._path().startswith(KEY_PREFIX):
            self._method_or_route_error()
            return
        key = self._decode_key()
        if key is None:
            return
        body = self._read_json()
        if body is None:
            return
        if not isinstance(body, dict) or "value" not in body or not set(body).issubset({"value", "ttl_seconds"}):
            self._error(HTTPStatus.BAD_REQUEST, "body must contain value and optional ttl_seconds")
            return
        ttl = body.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.server.store.put(key, body["value"], ttl)
            self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": body["value"]})
        except StorageError as exc:
            print(exc, file=sys.stderr, flush=True)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage operation failed")

    def do_DELETE(self) -> None:
        if not self._path().startswith(KEY_PREFIX):
            self._method_or_route_error()
            return
        key = self._decode_key()
        if key is None:
            return
        try:
            if not self.server.store.delete(key):
                self._error(HTTPStatus.NOT_FOUND, "key not found")
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except StorageError as exc:
            print(exc, file=sys.stderr, flush=True)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage operation failed")

    def _method_or_route_error(self) -> None:
        path = self._path()
        if path in {"/health", "/v1/keys"} or path.startswith(KEY_PREFIX):
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed", {"Allow": self._allowed_methods(path)})
        else:
            self._error(HTTPStatus.NOT_FOUND, "unknown route")

    @staticmethod
    def _allowed_methods(path: str) -> str:
        if path in {"/health", "/v1/keys"}:
            return "GET"
        return "GET, PUT, DELETE"

    def do_POST(self) -> None:
        self._method_or_route_error()

    def do_PATCH(self) -> None:
        self._method_or_route_error()

    def do_HEAD(self) -> None:
        self._method_or_route_error()

    def do_OPTIONS(self) -> None:
        self._method_or_route_error()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", default="127.0.0.1", help="address to bind")
    parser.add_argument("--port", type=int, required=True, help="port to bind (0 chooses a free port)")
    parser.add_argument("--data", type=Path, required=True, help="JSON storage file")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = Store(args.data.absolute())
        server = KeyValueServer((args.host, args.port), store)
    except (OSError, StorageError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop_server(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop_server)
    signal.signal(signal.SIGINT, stop_server)
    actual_port = server.server_address[1]
    print(f"LISTENING {actual_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
