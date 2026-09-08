#!/usr/bin/env python3
"""A small persistent HTTP key-value service using only the standard library."""

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


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


class PersistentStore:
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
                with self.path.open("r", encoding="utf-8") as stream:
                    document = json.load(stream)
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise StoreError(f"cannot read data file {self.path}: {exc}") from exc

            if not isinstance(document, dict) or document.get("version") != 1:
                raise StoreError(f"invalid data file format: {self.path}")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise StoreError(f"invalid data file entries: {self.path}")

            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            removed_expired = False
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise StoreError(f"invalid key in data file: {self.path}")
                if not isinstance(entry, dict) or "value" not in entry:
                    raise StoreError(f"invalid entry in data file: {self.path}")
                expires_at = entry.get("expires_at")
                if expires_at is not None:
                    if (
                        isinstance(expires_at, bool)
                        or not isinstance(expires_at, (int, float))
                        or not math.isfinite(expires_at)
                    ):
                        raise StoreError(f"invalid expiration in data file: {self.path}")
                    if expires_at <= now:
                        removed_expired = True
                        continue
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self._entries = loaded
            if removed_expired:
                self._persist_locked()

    def _purge_expired_locked(self) -> bool:
        now = time.time()
        expired = [
            key
            for key, entry in self._entries.items()
            if entry["expires_at"] is not None and entry["expires_at"] <= now
        ]
        for key in expired:
            del self._entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            encoded = json.dumps(
                {"version": 1, "entries": self._entries},
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    stream.write(encoded)
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary_name, self.path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    # Directory fsync is unavailable on some platforms. The file
                    # itself was still fsynced before the atomic replacement.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass
                raise
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self._lock:
            self._purge_expired_locked()
            created = key not in self._entries
            old_entry = self._entries.get(key)
            expires_at = time.time() + ttl_seconds if ttl_seconds is not None else None
            self._entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                if old_entry is None:
                    del self._entries[key]
                else:
                    self._entries[key] = old_entry
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            changed = self._purge_expired_locked()
            if changed:
                self._persist_locked()
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            self._purge_expired_locked()
            old_entry = self._entries.pop(key, None)
            if old_entry is None:
                return False
            try:
                self._persist_locked()
            except StoreError:
                self._entries[key] = old_entry
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            changed = self._purge_expired_locked()
            if changed:
                self._persist_locked()
            return sorted(self._entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: PersistentStore) -> None:
        self.store = store
        super().__init__(address, RequestHandler)

    def handle_error(self, request: Any, client_address: Any) -> None:
        print(f"request handling error from {client_address}", file=sys.stderr)
        super().handle_error(request, client_address)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"

    @property
    def store(self) -> PersistentStore:
        return self.server.store  # type: ignore[attr-defined, no-any-return]

    def log_message(self, format: str, *args: Any) -> None:
        print(
            "%s - - [%s] %s"
            % (self.address_string(), self.log_date_time_string(), format % args),
            file=sys.stderr,
        )

    def _send_json(self, status: int, body: Any) -> None:
        payload = json.dumps(
            body, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _route(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        path = parsed.path
        if parsed.query or parsed.fragment:
            return "unknown", None
        if path == "/health":
            return "health", None
        if path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return "unknown", None
        raw_key = path[len(prefix) :]
        if not raw_key or "/" in raw_key:
            return "invalid_key", None
        try:
            key = unquote_to_bytes(raw_key).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return "invalid_key", None
        if not key or "/" in key:
            return "invalid_key", None
        return "kv", key

    def _read_json_body(self) -> tuple[bool, Any]:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding and transfer_encoding.lower() != "identity":
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "unsupported transfer encoding")
            return False, None

        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            return False, None
        try:
            length = int(raw_length, 10)
        except ValueError:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return False, None
        if length < 0:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return False, None
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            return False, None

        content_type = self.headers.get_content_type()
        if content_type != "application/json":
            self.close_connection = True
            self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json")
            return False, None
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "incomplete request body")
            return False, None
        try:
            return True, json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return False, None

    def _store_error(self, exc: StoreError) -> None:
        print(str(exc), file=sys.stderr)
        self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage operation failed")

    def do_GET(self) -> None:
        route, key = self._route()
        try:
            if route == "health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
            elif route == "keys":
                self._send_json(HTTPStatus.OK, {"keys": self.store.keys()})
            elif route == "kv":
                found, value = self.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            elif route == "invalid_key":
                self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            else:
                self._error(HTTPStatus.NOT_FOUND, "route not found")
        except StoreError as exc:
            self._store_error(exc)

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            return
        if route != "kv":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
            return
        valid, document = self._read_json_body()
        if not valid:
            return
        if not isinstance(document, dict) or "value" not in document:
            self._error(HTTPStatus.BAD_REQUEST, "body must be a JSON object containing value")
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
            created = self.store.put(key, document["value"], ttl)  # type: ignore[arg-type]
        except StoreError as exc:
            self._store_error(exc)
            return
        self._send_json(
            HTTPStatus.CREATED if created else HTTPStatus.OK,
            {"key": key, "value": document["value"]},
        )

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            return
        if route != "kv":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
            return
        try:
            deleted = self.store.delete(key)  # type: ignore[arg-type]
        except StoreError as exc:
            self._store_error(exc)
            return
        if not deleted:
            self._error(HTTPStatus.NOT_FOUND, "key not found")
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:
        self._method_not_allowed()

    def do_PATCH(self) -> None:
        self._method_not_allowed()

    def do_OPTIONS(self) -> None:
        self._method_not_allowed()

    def do_HEAD(self) -> None:
        self._method_not_allowed()

    def _method_not_allowed(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", default="127.0.0.1", help="address to bind")
    parser.add_argument("--port", type=int, required=True, help="port to bind (0 selects a free port)")
    parser.add_argument("--data", type=Path, required=True, help="JSON persistence file")
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
        print(f"startup failed: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def request_stop(signum: int, frame: Any) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    server.timeout = 0.25
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        while not stopping.is_set():
            server.handle_request()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
