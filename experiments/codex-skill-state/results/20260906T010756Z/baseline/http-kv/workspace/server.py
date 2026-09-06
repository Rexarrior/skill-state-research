#!/usr/bin/env python3
"""Persistent, dependency-free HTTP key-value service."""

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
KV_PREFIX = "/v1/kv/"
BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(Exception):
    """A persistent-store operation failed."""


class Store:
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
            entries = document.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("data-file entries must be an object")

            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in entries.items():
                if not isinstance(key, str) or not self.valid_key(key):
                    raise ValueError("data file contains an invalid key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("data file contains an invalid entry")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("data file contains an invalid expiry")
                normalized = {"value": entry["value"], "expires_at": expires_at}
                if self._is_live(normalized, now):
                    loaded[key] = normalized
            self._entries = loaded
            if len(loaded) != len(entries):
                self._persist_locked()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> Any:
        raise ValueError(f"invalid JSON constant {value}")

    @staticmethod
    def valid_key(key: str) -> bool:
        return bool(key) and "/" not in key

    @staticmethod
    def normalize_ttl(value: Any) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        try:
            ttl = float(value)
        except (OverflowError, ValueError):
            return None
        if not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
            return None
        return ttl

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self._entries.items() if not self._is_live(entry, now)]
        for key in expired:
            del self._entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as destination:
                    json.dump(
                        {"version": 1, "entries": self._entries},
                        destination,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
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
                    # Some platforms/filesystems do not support syncing directories.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass
                raise
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self._lock:
            self._purge_locked()
            existed = key in self._entries
            previous = self._entries.get(key)
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            self._entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                if previous is None:
                    self._entries.pop(key, None)
                else:
                    self._entries[key] = previous
                raise
            return existed

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            purged = self._purge_locked()
            entry = self._entries.get(key)
            if purged:
                self._best_effort_persist_locked()
            if entry is None:
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            purged = self._purge_locked()
            previous = self._entries.pop(key, None)
            if previous is None:
                if purged:
                    self._best_effort_persist_locked()
                return False
            try:
                self._persist_locked()
            except StoreError:
                self._entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            if self._purge_locked():
                self._best_effort_persist_locked()
            return sorted(self._entries)

    def flush(self) -> None:
        with self._lock:
            self._purge_locked()
            self._persist_locked()

    def _best_effort_persist_locked(self) -> None:
        try:
            self._persist_locked()
        except StoreError as exc:
            print(f"warning: {exc}", file=sys.stderr, flush=True)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"{self.client_address[0]} - {format_string % args}",
            file=sys.stderr,
            flush=True,
        )

    def send_error(
        self, code: int, message: str | None = None, explain: str | None = None
    ) -> None:
        """Keep errors generated by BaseHTTPRequestHandler JSON-formatted."""
        if code == 501:
            self._unsupported()
            return
        self._error(code, message or "bad request")

    def _json(self, status: int, document: Any) -> None:
        payload = json.dumps(
            document, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _key(self) -> str | None:
        path = self._path()
        if not path.startswith(KV_PREFIX):
            return None
        encoded = path[len(KV_PREFIX) :]
        if BAD_ESCAPE.search(encoded):
            return None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        return key if Store.valid_key(key) else None

    def _known_route(self) -> bool:
        path = self._path()
        return path in {"/health", "/v1/keys"} or path.startswith(KV_PREFIX)

    def _invalid_key(self) -> None:
        self._error(400, "key must be non-empty valid UTF-8 and must not contain '/'")

    def _read_json(self) -> Any:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            raise RequestError(400, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(raw_length, 10)
        except ValueError as exc:
            raise RequestError(400, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            return json.loads(body, parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            raise RequestError(400, "malformed JSON") from exc

    def do_GET(self) -> None:
        path = self._path()
        if path == "/health":
            self._json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            self._json(200, {"keys": self.server.store.keys()})
            return
        key = self._key()
        if key is None:
            if path.startswith(KV_PREFIX):
                self._invalid_key()
            else:
                self._error(404, "route not found")
            return
        found, value = self.server.store.get(key)
        if not found:
            self._error(404, "key not found")
            return
        self._json(200, {"key": key, "value": value})

    def do_PUT(self) -> None:
        if not self._path().startswith(KV_PREFIX):
            self._unsupported()
            return
        key = self._key()
        if key is None:
            self._invalid_key()
            return
        try:
            document = self._read_json()
            if not isinstance(document, dict) or isinstance(document, list):
                raise RequestError(400, "request body must be a JSON object")
            if "value" not in document or not set(document).issubset({"value", "ttl_seconds"}):
                raise RequestError(400, "body must contain value and optional ttl_seconds")
            ttl = document.get("ttl_seconds")
            if "ttl_seconds" in document:
                ttl = Store.normalize_ttl(ttl)
                if ttl is None:
                    raise RequestError(
                        400, "ttl_seconds must be a finite number greater than zero"
                    )
            replaced = self.server.store.put(key, document["value"], ttl)
        except RequestError as exc:
            self._error(exc.status, exc.message)
            return
        except StoreError as exc:
            print(str(exc), file=sys.stderr, flush=True)
            self._error(500, "failed to persist data")
            return
        self._json(200 if replaced else 201, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        if not self._path().startswith(KV_PREFIX):
            self._unsupported()
            return
        key = self._key()
        if key is None:
            self._invalid_key()
            return
        try:
            deleted = self.server.store.delete(key)
        except StoreError as exc:
            print(str(exc), file=sys.stderr, flush=True)
            self._error(500, "failed to persist data")
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self.send_response(204)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unsupported(self) -> None:
        if not self._known_route():
            self._error(404, "route not found")
            return
        allowed = "GET" if self._path() in {"/health", "/v1/keys"} else "GET, PUT, DELETE"
        payload = json.dumps({"error": "method not allowed"}, separators=(",", ":")).encode()
        self.send_response(405)
        self.send_header("Allow", allowed)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        self.status = status
        self.message = message
        super().__init__(message)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
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
        server = Server((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    server.timeout = 0.25
    exit_code = 0
    try:
        while not stopping.is_set():
            server.handle_request()
    finally:
        server.server_close()
        try:
            store.flush()
        except StoreError as exc:
            print(f"shutdown warning: {exc}", file=sys.stderr, flush=True)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
