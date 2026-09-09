#!/usr/bin/env python3
"""A small, dependency-free, persistent HTTP key-value service."""

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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
_BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(Exception):
    """Raised when the persistent state cannot be read or written."""


class PersistentStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._wake = threading.Condition(self._lock)
        self._stopping = False
        self._load()
        self._cleaner = threading.Thread(
            target=self._expiry_worker, name="kv-expiry-cleaner", daemon=True
        )
        self._cleaner.start()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("expected a version 1 state document")
            entries = document.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("state entries must be an object")

            loaded: dict[str, dict[str, Any]] = {}
            now = time.time()
            removed_expired = False
            for key, record in entries.items():
                if not isinstance(key, str) or not isinstance(record, dict):
                    raise ValueError("invalid state entry")
                if set(record) != {"value", "expires_at"}:
                    raise ValueError("invalid state entry fields")
                expires_at = record["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiration timestamp")
                if expires_at is not None and expires_at <= now:
                    removed_expired = True
                    continue
                loaded[key] = {"value": record["value"], "expires_at": expires_at}
            self._entries = loaded
            if removed_expired:
                self._persist_locked(loaded)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    def _persist_locked(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(
                        {"version": 1, "entries": entries},
                        handle,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                    )
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary_name, self.path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                except OSError:
                    directory_fd = None
                if directory_fd is not None:
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    @staticmethod
    def _is_expired(record: dict[str, Any], now: float) -> bool:
        expires_at = record["expires_at"]
        return expires_at is not None and expires_at <= now

    def _purge_expired_locked(self, now: float) -> bool:
        expired = [
            key for key, record in self._entries.items() if self._is_expired(record, now)
        ]
        if not expired:
            return False
        updated = self._entries.copy()
        for key in expired:
            del updated[key]
        self._persist_locked(updated)
        self._entries = updated
        return True

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
        if expires_at is not None and not math.isfinite(expires_at):
            raise ValueError("ttl_seconds produces an invalid expiration time")
        with self._wake:
            self._purge_expired_locked(time.time())
            created = key not in self._entries
            updated = self._entries.copy()
            updated[key] = {"value": value, "expires_at": expires_at}
            self._persist_locked(updated)
            self._entries = updated
            self._wake.notify_all()
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._wake:
            self._purge_expired_locked(time.time())
            record = self._entries.get(key)
            if record is None:
                return False, None
            return True, record["value"]

    def delete(self, key: str) -> bool:
        with self._wake:
            self._purge_expired_locked(time.time())
            if key not in self._entries:
                return False
            updated = self._entries.copy()
            del updated[key]
            self._persist_locked(updated)
            self._entries = updated
            self._wake.notify_all()
            return True

    def keys(self) -> list[str]:
        with self._wake:
            self._purge_expired_locked(time.time())
            return sorted(self._entries)

    def _expiry_worker(self) -> None:
        with self._wake:
            while not self._stopping:
                expirations = [
                    record["expires_at"]
                    for record in self._entries.values()
                    if record["expires_at"] is not None
                ]
                if not expirations:
                    self._wake.wait()
                    continue
                delay = max(0.0, min(expirations) - time.time())
                if delay > 0:
                    self._wake.wait(timeout=delay)
                    continue
                try:
                    self._purge_expired_locked(time.time())
                except StoreError as exc:
                    print(f"expiry cleanup failed: {exc}", file=sys.stderr, flush=True)
                    self._wake.wait(timeout=1.0)

    def close(self) -> None:
        with self._wake:
            self._stopping = True
            self._wake.notify_all()
        self._cleaner.join()


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: PersistentStore):
        super().__init__(address, RequestHandler)
        self.store = store


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - {format % args}", file=sys.stderr, flush=True
        )

    def __getattr__(self, name: str) -> Any:
        if name.startswith("do_"):
            return self._unsupported_method
        raise AttributeError(name)

    def _send_json(
        self, status: int, payload: Any, extra_headers: dict[str, str] | None = None
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

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _route(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if not parsed.path.startswith(prefix):
            return "unknown", None
        encoded = parsed.path[len(prefix) :]
        if not encoded or "/" in encoded or _BAD_PERCENT_ESCAPE.search(encoded):
            return "invalid_key", None
        try:
            raw = encoded.encode("latin-1")
            key = unquote_to_bytes(raw).decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return "invalid_key", None
        if not key or "/" in key:
            return "invalid_key", None
        return "key", key

    def _read_put_body(self) -> dict[str, Any] | None:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._error(400, "transfer encoding is not supported")
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self.close_connection = True
            self._error(411, "Content-Length is required")
            return None
        try:
            length = int(raw_length, 10)
        except ValueError:
            self.close_connection = True
            self._error(400, "invalid Content-Length")
            return None
        if length < 0:
            self.close_connection = True
            self._error(400, "invalid Content-Length")
            return None
        if length > MAX_BODY_BYTES:
            # Consume the declared body without buffering it.  Responding and
            # closing immediately can reset the connection while a client is
            # still uploading, preventing it from receiving the 413 response.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    self.close_connection = True
                    break
                remaining -= len(chunk)
            self._error(413, "request body exceeds 1 MiB")
            return None
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            self._error(400, "incomplete request body")
            return None
        try:
            payload = json.loads(
                body.decode("utf-8"), parse_constant=PersistentStore._reject_constant
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._error(400, "malformed JSON")
            return None
        if not isinstance(payload, dict):
            self._error(400, "request body must be a JSON object")
            return None
        if "value" not in payload or not set(payload).issubset({"value", "ttl_seconds"}):
            self._error(400, "request body must contain value and optional ttl_seconds")
            return None
        ttl = payload.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return None
        return payload

    def do_GET(self) -> None:
        route, key = self._route()
        try:
            if route == "health":
                self._send_json(200, {"status": "ok"})
            elif route == "keys":
                self._send_json(200, {"keys": self.server.store.keys()})
            elif route == "key":
                present, value = self.server.store.get(key)  # type: ignore[arg-type]
                if present:
                    self._send_json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            elif route == "invalid_key":
                self._error(400, "invalid key")
            else:
                self._error(404, "route not found")
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._error(400, "invalid key")
            return
        if route != "key":
            self._error(404, "route not found")
            return
        payload = self._read_put_body()
        if payload is None:
            return
        try:
            created = self.server.store.put(
                key, payload["value"], payload.get("ttl_seconds")  # type: ignore[arg-type]
            )
            self._send_json(201 if created else 200, {"key": key, "value": payload["value"]})
        except ValueError as exc:
            self._error(400, str(exc))
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._error(400, "invalid key")
            return
        if route != "key":
            self._error(404, "route not found")
            return
        try:
            if self.server.store.delete(key):  # type: ignore[arg-type]
                self._send_empty(204)
            else:
                self._error(404, "key not found")
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def _unsupported_method(self) -> None:
        self._error(405, "method not allowed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = PersistentStore(args.data)
    except StoreError as exc:
        print(exc, file=sys.stderr, flush=True)
        return 1

    try:
        server = KVServer((args.host, args.port), store)
    except OSError as exc:
        store.close()
        print(f"cannot start server: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def request_stop(_signum: int, _frame: Any) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    server.timeout = 0.5
    actual_port = server.server_address[1]
    print(f"LISTENING {actual_port}", flush=True)
    try:
        while not stopping.is_set():
            server.handle_request()
    finally:
        server.server_close()
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
