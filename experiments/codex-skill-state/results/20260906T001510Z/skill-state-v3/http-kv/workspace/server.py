#!/usr/bin/env python3
"""A small persistent HTTP key-value service using only the standard library."""

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
from urllib.parse import unquote, urlsplit


MAX_BODY = 1024 * 1024
BAD_ESCAPE = re.compile(r"%(?![0-9a-fA-F]{2})")


class StoreError(Exception):
    """Raised when durable storage cannot be read or updated."""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle)
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("invalid top-level structure")
            loaded: dict[str, dict[str, Any]] = {}
            now = time.time()
            removed_expired = False
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError("invalid entry")
                if set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid entry fields")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiration")
                if expires_at is not None and expires_at <= now:
                    removed_expired = True
                    continue
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
            if removed_expired:
                self._persist_locked()
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    def _persist_locked(self) -> None:
        parent = self.path.parent
        temp_name: str | None = None
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=parent)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    {"entries": self.entries},
                    handle,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.path)
            temp_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some platforms/filesystems do not permit fsync on directories.
                pass
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass

    def _purge_locked(self, now: float) -> bool:
        expired = [
            key
            for key, entry in self.entries.items()
            if entry["expires_at"] is not None and entry["expires_at"] <= now
        ]
        for key in expired:
            del self.entries[key]
        if expired:
            self._persist_locked()
        return bool(expired)

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked(time.time())
            created = key not in self.entries
            previous = self.entries.get(key)
            expires_at = None if ttl is None else time.time() + ttl
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
            self._purge_locked(time.time())
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked(time.time())
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
            self._purge_locked(time.time())
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined,no-any-return]

    def _send(self, status: int, payload: Any | None = None) -> None:
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, code: str, message: str) -> None:
        self._send(status, {"error": code, "message": message})

    def _path(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if parsed.path.startswith(prefix) and "/" not in parsed.path[len(prefix):]:
            raw_key = parsed.path[len(prefix):]
            if BAD_ESCAPE.search(raw_key):
                return "invalid_key", None
            try:
                key = unquote(raw_key, encoding="utf-8", errors="strict")
            except UnicodeDecodeError:
                return "invalid_key", None
            if not key or "/" in key:
                return "invalid_key", None
            return "kv", key
        return "unknown", None

    def _read_json(self) -> Any | None:
        if self.headers.get("Transfer-Encoding"):
            self._error(400, "invalid_request", "transfer encoding is not supported")
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "length_required", "Content-Length is required")
            return None
        try:
            length = int(raw_length)
            if length < 0:
                raise ValueError
        except ValueError:
            self._error(400, "invalid_request", "invalid Content-Length")
            return None
        if length > MAX_BODY:
            self.close_connection = True
            self._error(413, "body_too_large", "request body exceeds 1 MiB")
            return None
        try:
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError("incomplete request body")

            def finite_float(text: str) -> float:
                number = float(text)
                if not math.isfinite(number):
                    raise ValueError("non-finite number")
                return number

            return json.loads(
                data.decode("utf-8"),
                parse_float=finite_float,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError(f"invalid constant {value}")
                ),
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(400, "invalid_json", "request body must be valid JSON")
            return None

    def do_GET(self) -> None:
        route, key = self._path()
        try:
            if route == "health":
                self._send(200, {"status": "ok"})
            elif route == "keys":
                self._send(200, {"keys": self.store.keys()})
            elif route == "kv":
                found, value = self.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._send(200, {"key": key, "value": value})
                else:
                    self._error(404, "not_found", "key not found")
            elif route == "invalid_key":
                self._error(400, "invalid_key", "key must be non-empty UTF-8 without '/'" )
            else:
                self._error(404, "not_found", "route not found")
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage_error", "persistent storage failed")

    def do_PUT(self) -> None:
        route, key = self._path()
        if route == "invalid_key":
            self._error(400, "invalid_key", "key must be non-empty UTF-8 without '/'")
            return
        if route != "kv":
            self._error(404, "not_found", "route not found")
            return
        document = self._read_json()
        if document is None:
            return
        if not isinstance(document, dict) or "value" not in document or not set(document) <= {
            "value", "ttl_seconds"
        }:
            self._error(400, "invalid_body", "body must contain value and optional ttl_seconds")
            return
        has_ttl = "ttl_seconds" in document
        ttl = document.get("ttl_seconds")
        if has_ttl and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "invalid_ttl", "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.store.put(key, document["value"], ttl)  # type: ignore[arg-type]
            self._send(201 if created else 200, {"key": key, "value": document["value"]})
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage_error", "persistent storage failed")

    def do_DELETE(self) -> None:
        route, key = self._path()
        if route == "invalid_key":
            self._error(400, "invalid_key", "key must be non-empty UTF-8 without '/'")
            return
        if route != "kv":
            self._error(404, "not_found", "route not found")
            return
        try:
            if self.store.delete(key):  # type: ignore[arg-type]
                self._send(204)
            else:
                self._error(404, "not_found", "key not found")
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage_error", "persistent storage failed")

    def _method_not_allowed(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        body = b'{"error":"method_not_allowed","message":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", default="127.0.0.1")
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
        print(f"startup error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(signum: int, _frame: Any) -> None:
        if stopping.is_set():
            return
        stopping.set()
        print(f"received signal {signum}, shutting down", file=sys.stderr)
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
