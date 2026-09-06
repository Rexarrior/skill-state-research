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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


MAX_BODY_BYTES = 1024 * 1024
_MISSING = object()


class StoreError(Exception):
    """Raised when durable storage cannot be read or written."""


class Store:
    """Thread-safe in-memory state backed by an atomically replaced JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("data-file entries must be an object")

            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            discarded_expired = False
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("data file contains an invalid key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("data file contains an invalid entry")
                expires_at = entry["expires_at"]
                if expires_at is not None:
                    if (
                        isinstance(expires_at, bool)
                        or not isinstance(expires_at, (int, float))
                        or (isinstance(expires_at, float) and not math.isfinite(expires_at))
                    ):
                        raise ValueError("data file contains an invalid expiry")
                if self._is_live(entry, now):
                    loaded[key] = entry
                else:
                    discarded_expired = True
            self._entries = loaded
            if discarded_expired:
                self._persist(loaded)
        except (OSError, ValueError, TypeError, json.JSONDecodeError, RecursionError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number {value}")

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(
                {"version": 1, "entries": entries},
                # ASCII escaping also makes lone surrogates accepted by the
                # standard JSON decoder safe to persist as valid UTF-8.
                ensure_ascii=True,
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(descriptor, "wb") as temporary:
                    temporary.write(payload)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_name, self.path)
                # Make the rename durable where directory fsync is supported.
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
        except (OSError, TypeError, ValueError, RecursionError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    def _remove_expired(self, now: float) -> bool:
        expired = [key for key, entry in self._entries.items() if not self._is_live(entry, now)]
        if not expired:
            return False
        for key in expired:
            del self._entries[key]
        try:
            self._persist(self._entries)
        except StoreError as exc:
            print(f"warning: {exc}", file=sys.stderr, flush=True)
        return True

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self._lock:
            now = time.time()
            self._remove_expired(now)
            created = key not in self._entries
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            replacement = dict(self._entries)
            replacement[key] = {"value": value, "expires_at": expires_at}
            self._persist(replacement)
            self._entries = replacement
            return created

    def get(self, key: str) -> Any:
        with self._lock:
            self._remove_expired(time.time())
            entry = self._entries.get(key)
            return _MISSING if entry is None else entry["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            self._remove_expired(time.time())
            if key not in self._entries:
                return False
            replacement = dict(self._entries)
            del replacement[key]
            self._persist(replacement)
            self._entries = replacement
            return True

    def keys(self) -> list[str]:
        with self._lock:
            self._remove_expired(time.time())
            return sorted(self._entries)


class KVHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "kv-service"
    sys_version = ""

    @property
    def kv_server(self) -> KVHTTPServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f'{self.address_string()} - [{self.log_date_time_string()}] {format % args}',
            file=sys.stderr,
            flush=True,
        )

    def send_error(
        self, code: int, message: str | None = None, explain: str | None = None
    ) -> None:
        """Keep errors generated by BaseHTTPRequestHandler JSON as well."""
        del explain
        if code == 501:
            self._method_not_allowed()
            return
        self.close_connection = True
        self._error(code, "http_error", message or "HTTP request error")

    def _send_json(self, status: int, body: Any | None, *, allow: str | None = None) -> None:
        encoded = b"" if body is None else json.dumps(
            body, ensure_ascii=True, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        if allow is not None:
            self.send_header("Allow", allow)
        self.end_headers()
        if self.command != "HEAD" and encoded:
            self.wfile.write(encoded)

    def _error(self, status: int, code: str, message: str, *, allow: str | None = None) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}}, allow=allow)

    def _path(self) -> str | None:
        try:
            return urlsplit(self.path).path
        except ValueError:
            self._error(400, "invalid_path", "Invalid request path")
            return None

    def _key(self, path: str) -> str | None:
        prefix = "/v1/kv/"
        encoded_key = path[len(prefix) :]
        # urllib deliberately leaves malformed percent escapes untouched, so
        # validate them before decoding.
        index = 0
        while index < len(encoded_key):
            if encoded_key[index] == "%":
                if index + 2 >= len(encoded_key) or any(
                    char not in "0123456789abcdefABCDEF" for char in encoded_key[index + 1 : index + 3]
                ):
                    self._error(400, "invalid_key", "Key is not valid URL encoding")
                    return None
                index += 3
            else:
                index += 1
        try:
            key = unquote(encoded_key, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            self._error(400, "invalid_key", "Key must decode as UTF-8")
            return None
        if not key:
            self._error(400, "invalid_key", "Key must not be empty")
            return None
        if "/" in key:
            self._error(400, "invalid_key", "Key must not contain '/'")
            return None
        return key

    @staticmethod
    def _route_exists(path: str) -> bool:
        return path in {"/health", "/v1/keys"} or path.startswith("/v1/kv/")

    @staticmethod
    def _allowed_methods(path: str) -> str:
        if path.startswith("/v1/kv/"):
            return "GET, PUT, DELETE"
        return "GET"

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._error(400, "unsupported_transfer_encoding", "Transfer-Encoding is not supported")
            return _MISSING

        lengths = self.headers.get_all("Content-Length", [])
        if not lengths:
            self.close_connection = True
            self._error(411, "length_required", "Content-Length is required")
            return _MISSING
        if len(set(lengths)) != 1:
            self.close_connection = True
            self._error(400, "invalid_content_length", "Conflicting Content-Length headers")
            return _MISSING
        try:
            length = int(lengths[0], 10)
        except ValueError:
            self.close_connection = True
            self._error(400, "invalid_content_length", "Content-Length must be an integer")
            return _MISSING
        if length < 0:
            self.close_connection = True
            self._error(400, "invalid_content_length", "Content-Length must not be negative")
            return _MISSING
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._error(413, "body_too_large", "Request body exceeds 1 MiB")
            return _MISSING
        raw = self.rfile.read(length)
        if len(raw) != length:
            self.close_connection = True
            self._error(400, "incomplete_body", "Request body is incomplete")
            return _MISSING
        try:
            return json.loads(raw.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
            self._error(400, "malformed_json", "Body must be valid UTF-8 JSON")
            return _MISSING

    def do_GET(self) -> None:
        path = self._path()
        if path is None:
            return
        if path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            self._send_json(200, {"keys": self.kv_server.store.keys()})
            return
        if path.startswith("/v1/kv/"):
            key = self._key(path)
            if key is None:
                return
            value = self.kv_server.store.get(key)
            if value is _MISSING:
                self._error(404, "not_found", "Key not found")
            else:
                self._send_json(200, {"key": key, "value": value})
            return
        self._error(404, "not_found", "Route not found")

    def do_PUT(self) -> None:
        path = self._path()
        if path is None:
            return
        if not path.startswith("/v1/kv/"):
            self.close_connection = True
            if self._route_exists(path):
                self._error(
                    405,
                    "method_not_allowed",
                    "Method not allowed",
                    allow=self._allowed_methods(path),
                )
            else:
                self._error(404, "not_found", "Route not found")
            return
        key = self._key(path)
        if key is None:
            self.close_connection = True
            return
        body = self._read_json()
        if body is _MISSING:
            return
        if not isinstance(body, dict):
            self._error(400, "invalid_body", "Body must be a JSON object")
            return
        if "value" not in body or not set(body).issubset({"value", "ttl_seconds"}):
            self._error(400, "invalid_body", "Body requires 'value' and only supports 'ttl_seconds'")
            return
        ttl = body.get("ttl_seconds")
        if "ttl_seconds" in body:
            try:
                ttl_as_float = float(ttl)
            except (TypeError, ValueError, OverflowError):
                ttl_as_float = math.nan
            if (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl_as_float)
                or ttl_as_float <= 0
            ):
                self._error(400, "invalid_ttl", "ttl_seconds must be finite and greater than zero")
                return
            ttl = ttl_as_float
        try:
            created = self.kv_server.store.put(key, body["value"], ttl)
        except StoreError as exc:
            print(f"error: {exc}", file=sys.stderr, flush=True)
            self._error(500, "storage_error", "Could not persist the value")
            return
        self._send_json(201 if created else 200, {"key": key, "value": body["value"]})

    def do_DELETE(self) -> None:
        path = self._path()
        if path is None:
            return
        if not path.startswith("/v1/kv/"):
            if self._route_exists(path):
                self._error(
                    405,
                    "method_not_allowed",
                    "Method not allowed",
                    allow=self._allowed_methods(path),
                )
            else:
                self._error(404, "not_found", "Route not found")
            return
        key = self._key(path)
        if key is None:
            return
        try:
            deleted = self.kv_server.store.delete(key)
        except StoreError as exc:
            print(f"error: {exc}", file=sys.stderr, flush=True)
            self._error(500, "storage_error", "Could not persist the deletion")
            return
        if deleted:
            self._send_json(204, None)
        else:
            self._error(404, "not_found", "Key not found")

    def _method_not_allowed(self) -> None:
        self.close_connection = True
        path = self._path()
        if path is None:
            return
        if not self._route_exists(path):
            self._error(404, "not_found", "Route not found")
            return
        self._error(
            405,
            "method_not_allowed",
            "Method not allowed",
            allow=self._allowed_methods(path),
        )

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_CONNECT = _method_not_allowed
    do_TRACE = _method_not_allowed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", required=True)
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
    except (OSError, StoreError) as exc:
        print(f"error: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def request_stop(_signum: int, _frame: Any) -> None:
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
