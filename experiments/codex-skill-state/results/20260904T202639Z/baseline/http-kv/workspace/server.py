#!/usr/bin/env python3
"""A small, persistent HTTP key-value service using only the standard library."""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import socket
import tempfile
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes


MAX_BODY_BYTES = 1024 * 1024
MAX_REJECTED_BODY_DRAIN = 8 * MAX_BODY_BYTES
HEX_DIGITS = frozenset("0123456789abcdefABCDEF")


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


@dataclass
class Entry:
    value: Any
    expires_at: float | None


class PersistentStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._entries: dict[str, Entry] = {}
        self._lock = threading.RLock()
        self._load()

    @staticmethod
    def _is_live(entry: Entry, now: float) -> bool:
        return entry.expires_at is None or entry.expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            records = document.get("entries")
            if not isinstance(records, dict):
                raise ValueError("data file has no entries object")

            now = time.time()
            loaded: dict[str, Entry] = {}
            expired_found = False
            for key, record in records.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("data file contains an invalid key")
                if not isinstance(record, dict) or set(record) != {"value", "expires_at"}:
                    raise ValueError("data file contains an invalid entry")
                expires_at = record["expires_at"]
                if expires_at is not None:
                    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
                        raise ValueError("data file contains an invalid expiration")
                    try:
                        expires_at = float(expires_at)
                    except OverflowError as exc:
                        raise ValueError("data file contains an invalid expiration") from exc
                    if not math.isfinite(expires_at):
                        raise ValueError("data file contains an invalid expiration")
                entry = Entry(record["value"], expires_at)
                if self._is_live(entry, now):
                    loaded[key] = entry
                else:
                    expired_found = True
            self._entries = loaded
            if expired_found:
                self._persist_locked(now)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number {value}")

    def _live_document(self, now: float) -> dict[str, Any]:
        return {
            "version": 1,
            "entries": {
                key: {"value": entry.value, "expires_at": entry.expires_at}
                for key, entry in self._entries.items()
                if self._is_live(entry, now)
            },
        }

    def _persist_locked(self, now: float) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as target:
                temporary_name = target.name
                json.dump(
                    self._live_document(now),
                    target,
                    ensure_ascii=True,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
                target.write("\n")
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some platforms/filesystems do not support fsync on directories.
                pass
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass

    def _remove_expired_locked(self, now: float) -> bool:
        expired = [key for key, entry in self._entries.items() if not self._is_live(entry, now)]
        if not expired:
            return False
        for key in expired:
            del self._entries[key]
        self._persist_locked(now)
        return True

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self._lock:
            now = time.time()
            old_entries = self._entries.copy()
            created = key not in self._entries or not self._is_live(self._entries[key], now)
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            self._entries[key] = Entry(value, expires_at)
            try:
                self._remove_expired_without_persist_locked(now)
                self._persist_locked(now)
            except StoreError:
                self._entries = old_entries
                raise
            return created

    def _remove_expired_without_persist_locked(self, now: float) -> None:
        for key in [k for k, entry in self._entries.items() if not self._is_live(entry, now)]:
            del self._entries[key]

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            now = time.time()
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            if not self._is_live(entry, now):
                old_entries = self._entries.copy()
                del self._entries[key]
                try:
                    self._persist_locked(now)
                except StoreError:
                    self._entries = old_entries
                    raise
                return False, None
            return True, entry.value

    def delete(self, key: str) -> bool:
        with self._lock:
            now = time.time()
            entry = self._entries.get(key)
            if entry is None or not self._is_live(entry, now):
                if entry is not None:
                    old_entries = self._entries.copy()
                    del self._entries[key]
                    try:
                        self._persist_locked(now)
                    except StoreError:
                        self._entries = old_entries
                        raise
                return False
            old_entries = self._entries.copy()
            del self._entries[key]
            try:
                self._remove_expired_without_persist_locked(now)
                self._persist_locked(now)
            except StoreError:
                self._entries = old_entries
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            now = time.time()
            old_entries = self._entries.copy()
            changed = any(not self._is_live(entry, now) for entry in self._entries.values())
            if changed:
                self._remove_expired_without_persist_locked(now)
                try:
                    self._persist_locked(now)
                except StoreError:
                    self._entries = old_entries
                    raise
            return sorted(self._entries)


class KVRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"

    @property
    def store(self) -> PersistentStore:
        return self.server.store  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: object) -> None:
        # BaseHTTPRequestHandler's logger already writes to stderr.
        super().log_message(format, *args)

    def __getattr__(self, name: str) -> Any:
        # BaseHTTPRequestHandler otherwise emits an HTML 501 response for an
        # unknown verb. Route every syntactically valid HTTP method through the
        # JSON dispatcher instead.
        if name.startswith("do_"):
            return self._dispatch
        raise AttributeError(name)

    def _json_response(self, status: int, payload: Any) -> None:
        encoded = json.dumps(
            payload, ensure_ascii=True, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _empty_response(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, code: str, message: str) -> None:
        self._json_response(status, {"error": code, "message": message})

    def _content_length(self, required: bool = False) -> int | None:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            self._error(HTTPStatus.BAD_REQUEST, "unsupported_transfer_encoding", "chunked request bodies are not supported")
            return None
        values = self.headers.get_all("Content-Length", failobj=[])
        if not values:
            if required:
                self._error(HTTPStatus.LENGTH_REQUIRED, "length_required", "Content-Length is required")
            return None
        if len(values) != 1:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_content_length", "exactly one Content-Length header is required")
            return None
        try:
            length = int(values[0], 10)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_content_length", "Content-Length must be an integer")
            return None
        if length < 0:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_content_length", "Content-Length cannot be negative")
            return None
        if length > MAX_BODY_BYTES:
            if length <= MAX_REJECTED_BODY_DRAIN:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(remaining, 64 * 1024))
                    if not chunk:
                        break
                    remaining -= len(chunk)
            else:
                # Do not let a forged, enormous Content-Length hold a worker
                # indefinitely. Closing also prevents unread bytes from being
                # interpreted as another request on this connection.
                self.close_connection = True
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "body_too_large", "request body exceeds 1 MiB")
            return None
        return length

    def _read_json_object(self) -> dict[str, Any] | None:
        length = self._content_length(required=True)
        if length is None:
            return None
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("incomplete request body")
            parsed = json.loads(raw.decode("utf-8"), parse_constant=PersistentStore._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json", f"malformed JSON: {exc}")
            return None
        if not isinstance(parsed, dict):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_body", "request body must be a JSON object")
            return None
        return parsed

    @staticmethod
    def _decode_key(encoded: str) -> str:
        for index, character in enumerate(encoded):
            if character == "%" and (
                index + 2 >= len(encoded)
                or encoded[index + 1] not in HEX_DIGITS
                or encoded[index + 2] not in HEX_DIGITS
            ):
                raise ValueError("key contains an invalid percent escape")
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ValueError("key is not valid UTF-8") from exc
        if not key:
            raise ValueError("key cannot be empty")
        if "/" in key:
            raise ValueError("key cannot contain '/'")
        return key

    def _route(self) -> tuple[str, str | None]:
        # The request target is normally origin-form. Splitting explicitly also
        # avoids urlsplit interpreting malformed paths as authority-form URLs.
        path = self.path.partition("?")[0]
        if path == "/health":
            return "health", None
        if path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if path.startswith(prefix):
            encoded_key = path[len(prefix) :]
            if "/" in encoded_key:
                return "unknown", None
            try:
                return "key", self._decode_key(encoded_key)
            except ValueError as exc:
                return "invalid_key", str(exc)
        return "unknown", None

    def _dispatch(self) -> None:
        route, argument = self._route()
        if route == "unknown":
            self._error(HTTPStatus.NOT_FOUND, "not_found", "unknown route")
            return
        if route == "invalid_key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid_key", argument or "invalid key")
            return

        allowed = {
            "health": {"GET"},
            "keys": {"GET"},
            "key": {"GET", "PUT", "DELETE"},
        }[route]
        if self.command not in allowed:
            self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
            self.send_header("Allow", ", ".join(sorted(allowed)))
            payload = json.dumps(
                {"error": "method_not_allowed", "message": "method is not allowed for this route"},
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)
            return

        try:
            if route == "health":
                self._json_response(HTTPStatus.OK, {"status": "ok"})
            elif route == "keys":
                self._json_response(HTTPStatus.OK, {"keys": self.store.keys()})
            elif self.command == "GET":
                found, value = self.store.get(argument or "")
                if found:
                    self._json_response(HTTPStatus.OK, {"key": argument, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", "key not found")
            elif self.command == "DELETE":
                if self.store.delete(argument or ""):
                    self._empty_response(HTTPStatus.NO_CONTENT)
                else:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", "key not found")
            else:
                self._handle_put(argument or "")
        except StoreError as exc:
            self.log_error("storage failure: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "persistent storage failed")

    def _handle_put(self, key: str) -> None:
        body = self._read_json_object()
        if body is None:
            return
        if "value" not in body or not set(body).issubset({"value", "ttl_seconds"}):
            self._error(
                HTTPStatus.BAD_REQUEST,
                "invalid_body",
                "body must contain value and may contain ttl_seconds",
            )
            return
        ttl: float | None = None
        if "ttl_seconds" in body:
            raw_ttl = body["ttl_seconds"]
            if isinstance(raw_ttl, bool) or not isinstance(raw_ttl, (int, float)):
                self._error(HTTPStatus.BAD_REQUEST, "invalid_ttl", "ttl_seconds must be finite and greater than zero")
                return
            try:
                ttl = float(raw_ttl)
            except OverflowError:
                ttl = None
            if ttl is None or not math.isfinite(ttl) or ttl <= 0:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_ttl", "ttl_seconds must be finite and greater than zero")
                return
            if not math.isfinite(time.time() + ttl):
                self._error(HTTPStatus.BAD_REQUEST, "invalid_ttl", "ttl_seconds is too large")
                return
        created = self.store.put(key, body["value"], ttl)
        self._json_response(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": body["value"]})

    do_GET = _dispatch
    do_PUT = _dispatch
    do_DELETE = _dispatch
    do_POST = _dispatch
    do_PATCH = _dispatch
    do_HEAD = _dispatch
    do_OPTIONS = _dispatch
    do_CONNECT = _dispatch
    do_TRACE = _dispatch


class KVHTTPServer(ThreadingHTTPServer):
    # An idle HTTP/1.1 keep-alive client must not prevent SIGTERM shutdown.
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: PersistentStore) -> None:
        self.store = store
        super().__init__(address, KVRequestHandler)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind")
    parser.add_argument("--port", required=True, type=int, help="TCP port (0 chooses a free port)")
    parser.add_argument("--data", required=True, type=Path, help="JSON data-file path")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = PersistentStore(args.data)
        address_family = socket.AF_INET6 if ":" in args.host else socket.AF_INET
        server_class = type("ConfiguredKVHTTPServer", (KVHTTPServer,), {"address_family": address_family})
        server = server_class((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup error: {exc}", file=os.sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def request_shutdown(signum: int, frame: object) -> None:
        del signum, frame
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, name="shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)

    actual_port = server.server_address[1]
    print(f"LISTENING {actual_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
