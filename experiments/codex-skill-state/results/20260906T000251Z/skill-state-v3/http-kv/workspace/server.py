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


MAX_BODY = 1024 * 1024
_MISSING = object()


class Store:
    """Thread-safe key/value storage backed by an atomically replaced JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as source:
            document = json.load(source, parse_constant=self._reject_constant)
        if not isinstance(document, dict) or not isinstance(document.get("entries"), dict):
            raise ValueError("data file has an invalid format")

        now = time.time()
        loaded: dict[str, dict[str, Any]] = {}
        for key, entry in document["entries"].items():
            if not isinstance(key, str) or not isinstance(entry, dict) or "value" not in entry:
                raise ValueError("data file has an invalid entry")
            expires_at = entry.get("expires_at")
            if expires_at is not None and (
                isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or not math.isfinite(expires_at)
            ):
                raise ValueError("data file has an invalid expiration time")
            normalized = {"value": entry["value"], "expires_at": expires_at}
            if self._live(normalized, now):
                loaded[key] = normalized
        self.entries = loaded
        # Remove expired records from disk during startup as well as from memory.
        if len(loaded) != len(document["entries"]):
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    def _prune_locked(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as target:
                json.dump(
                    {"entries": self.entries},
                    target,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
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
                # Directory fsync is not supported on every platform/filesystem.
                pass
        except BaseException:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._prune_locked(now)
            previous = self.entries.get(key, _MISSING)
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl_seconds is None else now + ttl_seconds,
            }
            try:
                self._persist_locked()
            except BaseException:
                if previous is _MISSING:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return previous is _MISSING

    def get(self, key: str) -> Any:
        with self.lock:
            now = time.time()
            entry = self.entries.get(key)
            if entry is None:
                return _MISSING
            if not self._live(entry, now):
                del self.entries[key]
                self._persist_locked()
                return _MISSING
            return entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            now = time.time()
            self._prune_locked(now)
            previous = self.entries.pop(key, _MISSING)
            if previous is _MISSING:
                return False
            try:
                self._persist_locked()
            except BaseException:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._prune_locked(time.time()):
                self._persist_locked()
            return sorted(self.entries)

    def compact(self) -> None:
        with self.lock:
            changed = self._prune_locked(time.time())
            if changed or self.path.exists():
                self._persist_locked()


class KVServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def _json(self, status: int, document: Any) -> None:
        payload = json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _route(self) -> tuple[str, str | None]:
        path = urlsplit(self.path).path
        if path == "/health":
            return "health", None
        if path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return "unknown", None
        encoded = path[len(prefix) :]
        if not encoded or "/" in encoded:
            return "bad-key", None
        # urllib intentionally accepts malformed percent escapes, so reject them explicitly.
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                if index + 2 >= len(encoded) or any(char not in "0123456789abcdefABCDEF" for char in encoded[index + 1 : index + 3]):
                    return "bad-key", None
                index += 3
            else:
                index += 1
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return "bad-key", None
        if not key or "/" in key:
            return "bad-key", None
        return "kv", key

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
        try:
            length = int(raw_length, 10)
        except ValueError:
            raise RequestError(HTTPStatus.BAD_REQUEST, "invalid Content-Length") from None
        if length < 0:
            raise RequestError(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        if length > MAX_BODY:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            return json.loads(body.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise RequestError(HTTPStatus.BAD_REQUEST, "malformed JSON") from None

    def do_GET(self) -> None:
        route, key = self._route()
        try:
            if route == "health":
                self._json(HTTPStatus.OK, {"status": "ok"})
            elif route == "keys":
                self._json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            elif route == "kv":
                value = self.server.store.get(key)  # type: ignore[arg-type]
                if value is _MISSING:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
                else:
                    self._json(HTTPStatus.OK, {"key": key, "value": value})
            elif route == "bad-key":
                self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            else:
                self._error(HTTPStatus.NOT_FOUND, "route not found")
        except OSError as exc:
            self._storage_error(exc)

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "bad-key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            return
        if route != "kv":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
            return
        try:
            document = self._read_json()
            if not isinstance(document, dict) or "value" not in document or not set(document).issubset({"value", "ttl_seconds"}):
                raise RequestError(HTTPStatus.BAD_REQUEST, "body must contain value and optional ttl_seconds")
            ttl = document.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(HTTPStatus.BAD_REQUEST, "ttl_seconds must be a finite number greater than zero")
            created = self.server.store.put(key, document["value"], ttl)  # type: ignore[arg-type]
            self._json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": document["value"]})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except OSError as exc:
            self._storage_error(exc)

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "bad-key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            return
        if route != "kv":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
            return
        try:
            if not self.server.store.delete(key):  # type: ignore[arg-type]
                self._error(HTTPStatus.NOT_FOUND, "key not found")
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except OSError as exc:
            self._storage_error(exc)

    def _unsupported(self) -> None:
        route, _ = self._route()
        if route == "unknown":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
        elif route == "bad-key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
        else:
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported

    def _storage_error(self, exc: OSError) -> None:
        print(f"storage error: {exc}", file=sys.stderr, flush=True)
        self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage operation failed")

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}", file=sys.stderr, flush=True)


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        self.status = status
        self.message = message
        super().__init__(message)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
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
        store = Store(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
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
    exit_code = 0
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        try:
            store.compact()
        except OSError as exc:
            print(f"shutdown storage error: {exc}", file=sys.stderr)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
