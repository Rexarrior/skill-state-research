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
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
KV_PREFIX = "/v1/kv/"


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


@dataclass(frozen=True)
class Entry:
    value: Any
    expires_at: float | None


class PersistentStore:
    """A lock-protected store whose writes are atomically persisted."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._entries = self._load()

        # Rewrite on startup if the file contained expired records. This makes
        # it impossible for those records to be resurrected by a later clock
        # change or by copying the current state file.
        with self._lock:
            live = self._live_entries(self._entries, time.time())
            if live != self._entries:
                self._persist(live)
                self._entries = live

    @staticmethod
    def _live_entries(entries: dict[str, Entry], now: float) -> dict[str, Entry]:
        return {
            key: entry
            for key, entry in entries.items()
            if entry.expires_at is None or entry.expires_at > now
        }

    def _load(self) -> dict[str, Entry]:
        if not self.path.exists():
            return {}
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported or missing state-file version")
            records = document.get("entries")
            if not isinstance(records, dict):
                raise ValueError("state-file entries must be an object")

            loaded: dict[str, Entry] = {}
            for key, record in records.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("state file contains an invalid key")
                if not isinstance(record, dict) or set(record) != {"value", "expires_at"}:
                    raise ValueError("state file contains an invalid entry")
                expires_at = record["expires_at"]
                if expires_at is not None:
                    if (
                        isinstance(expires_at, bool)
                        or not isinstance(expires_at, (int, float))
                        or not math.isfinite(expires_at)
                    ):
                        raise ValueError("state file contains an invalid expiry")
                    expires_at = float(expires_at)
                loaded[key] = Entry(record["value"], expires_at)
            return loaded
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"non-standard JSON number {value}")

    def _persist(self, entries: dict[str, Entry]) -> None:
        parent = self.path.parent
        temporary: str | None = None
        document = {
            "version": 1,
            "entries": {
                key: {"value": entry.value, "expires_at": entry.expires_at}
                for key, entry in entries.items()
            },
        }
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    document,
                    handle,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            temporary = None
            # Persist the directory entry where the platform supports it.
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def _purge_locked(self, now: float) -> None:
        live = self._live_entries(self._entries, now)
        if len(live) != len(self._entries):
            self._persist(live)
            self._entries = live

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        now = time.time()
        expires_at = None if ttl_seconds is None else now + ttl_seconds
        with self._lock:
            current = self._live_entries(self._entries, now)
            created = key not in current
            updated = dict(current)
            updated[key] = Entry(value, expires_at)
            self._persist(updated)
            self._entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            self._purge_locked(time.time())
            entry = self._entries.get(key)
            return (False, None) if entry is None else (True, entry.value)

    def delete(self, key: str) -> bool:
        with self._lock:
            now = time.time()
            current = self._live_entries(self._entries, now)
            if key not in current:
                if len(current) != len(self._entries):
                    self._persist(current)
                    self._entries = current
                return False
            updated = dict(current)
            del updated[key]
            self._persist(updated)
            self._entries = updated
            return True

    def keys(self) -> list[str]:
        with self._lock:
            self._purge_locked(time.time())
            return sorted(self._entries)


class KVHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def __init__(self, address: tuple[str, int], store: PersistentStore):
        super().__init__(address, RequestHandler)
        self.store = store


class RequestHandler(BaseHTTPRequestHandler):
    server: KVHTTPServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(
            f"{self.client_address[0]} - [{self.log_date_time_string()}] {fmt % args}",
            file=sys.stderr,
        )

    def _send_json(
        self,
        status: int | HTTPStatus,
        payload: Any,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int | HTTPStatus, message: str) -> None:
        self._send_json(status, {"error": message})

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        """Keep parser-level and unrecognized-method errors JSON as well."""
        del explain
        try:
            default = HTTPStatus(code).phrase.lower()
        except ValueError:
            default = "request error"
        self._error(code, message or default)

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _key(self) -> str | None:
        path = self._path()
        if not path.startswith(KV_PREFIX):
            return None
        encoded = path[len(KV_PREFIX) :]
        if not encoded or "/" in encoded:
            return None
        # urllib accepts malformed percent escapes literally; reject them.
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                if index + 2 >= len(encoded) or any(
                    char not in "0123456789abcdefABCDEF" for char in encoded[index + 1 : index + 3]
                ):
                    return None
                index += 3
            else:
                index += 1
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        return key if key and "/" not in key else None

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            raise RequestProblem(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
        try:
            length = int(length_header, 10)
        except ValueError:
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "invalid Content-Length") from None
        if length < 0:
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            raise RequestProblem(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
        raw = self.rfile.read(length)
        if len(raw) != length:
            self.close_connection = True
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "incomplete request body")
        try:
            return json.loads(raw.decode("utf-8"), parse_constant=PersistentStore._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "malformed JSON") from None

    def do_GET(self) -> None:
        try:
            path = self._path()
            if path == "/health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
                return
            key = self._key()
            if key is None:
                self._error(HTTPStatus.NOT_FOUND, "route not found")
                return
            found, value = self.server.store.get(key)
            if not found:
                self._error(HTTPStatus.NOT_FOUND, "key not found")
                return
            self._send_json(HTTPStatus.OK, {"key": key, "value": value})
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def do_PUT(self) -> None:
        key = self._key()
        if key is None:
            self.close_connection = True  # An unread request body may remain.
            self._error(HTTPStatus.BAD_REQUEST if self._path().startswith(KV_PREFIX) else HTTPStatus.NOT_FOUND,
                        "invalid key" if self._path().startswith(KV_PREFIX) else "route not found")
            return
        try:
            document = self._read_json()
            if not isinstance(document, dict) or not set(document).issubset({"value", "ttl_seconds"}) or "value" not in document:
                raise RequestProblem(HTTPStatus.BAD_REQUEST, "body must contain value and optional ttl_seconds")
            ttl = document.get("ttl_seconds")
            if "ttl_seconds" in document:
                if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0:
                    raise RequestProblem(HTTPStatus.BAD_REQUEST, "ttl_seconds must be a finite number greater than zero")
                ttl = float(ttl)
            created = self.server.store.put(key, document["value"], ttl)
            self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK,
                            {"key": key, "value": document["value"]})
        except RequestProblem as exc:
            self._error(exc.status, exc.message)
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def do_DELETE(self) -> None:
        key = self._key()
        if key is None:
            self._error(HTTPStatus.BAD_REQUEST if self._path().startswith(KV_PREFIX) else HTTPStatus.NOT_FOUND,
                        "invalid key" if self._path().startswith(KV_PREFIX) else "route not found")
            return
        try:
            if not self.server.store.delete(key):
                self._error(HTTPStatus.NOT_FOUND, "key not found")
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def _unsupported(self) -> None:
        self.close_connection = True  # Do not reuse a connection with an unread body.
        path = self._path()
        known = path in {"/health", "/v1/keys"} or self._key() is not None
        if known:
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
        else:
            self._error(HTTPStatus.NOT_FOUND, "route not found")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported
    do_CONNECT = _unsupported
    do_TRACE = _unsupported


class RequestProblem(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        self.status = status
        self.message = message
        super().__init__(message)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True, type=Path)
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        store = PersistentStore(args.data)
        server = KVHTTPServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            # shutdown() must run outside the serve_forever() thread.
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
