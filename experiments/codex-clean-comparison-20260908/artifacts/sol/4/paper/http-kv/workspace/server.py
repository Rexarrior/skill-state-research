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
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, tuple[Any, float | None]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._bad_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, list):
                raise ValueError("data-file entries must be a list")
            loaded: dict[str, tuple[Any, float | None]] = {}
            for item in raw_entries:
                if not isinstance(item, dict) or set(item) != {"key", "value", "expires_at"}:
                    raise ValueError("invalid data-file entry")
                key = item["key"]
                expires = item["expires_at"]
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid key in data file")
                if expires is not None and (
                    isinstance(expires, bool)
                    or not isinstance(expires, (int, float))
                    or not math.isfinite(expires)
                ):
                    raise ValueError("invalid expiry in data file")
                loaded[key] = (item["value"], float(expires) if expires is not None else None)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        now = time.time()
        self.entries = {
            key: entry
            for key, entry in loaded.items()
            if entry[1] is None or entry[1] > now
        }
        if len(self.entries) != len(loaded):
            self._persist_locked()

    @staticmethod
    def _bad_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _remove_expired_locked(self) -> bool:
        now = time.time()
        expired = [
            key
            for key, (_, expires) in self.entries.items()
            if expires is not None and expires <= now
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        document = {
            "version": 1,
            "entries": [
                {"key": key, "value": value, "expires_at": expires}
                for key, (value, expires) in sorted(self.entries.items())
            ],
        }
        temp_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temp_name = handle.name
                json.dump(document, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
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
                pass
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except FileNotFoundError:
                    pass

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._remove_expired_locked()
            created = key not in self.entries
            old = self.entries.get(key)
            expires = time.time() + ttl if ttl is not None else None
            self.entries[key] = (value, expires)
            try:
                self._persist_locked()
            except Exception:
                if old is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = old
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            removed = self._remove_expired_locked()
            if removed:
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry[0])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._remove_expired_locked()
            if key not in self.entries:
                return False
            old = self.entries.pop(key)
            try:
                self._persist_locked()
            except Exception:
                self.entries[key] = old
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            removed = self._remove_expired_locked()
            if removed:
                self._persist_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True
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

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _send_json(self, status: int, body: Any | None) -> None:
        payload = b"" if body is None else json.dumps(
            body, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _route_path(self) -> str | None:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self._error(400, "invalid request target")
            return None
        if parsed.query or parsed.fragment:
            self._error(404, "route not found")
            return None
        return parsed.path

    def _key_from_path(self, path: str) -> str | None:
        encoded = path[len(KEY_PREFIX):]
        if not encoded:
            self._error(400, "key must not be empty")
            return None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            self._error(400, "key must be valid UTF-8")
            return None
        if not key or "/" in key:
            self._error(400, "key must be non-empty and must not contain '/'")
            return None
        return key

    def _read_json(self) -> Any | None:
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._error(411, "Content-Length is required")
            return None
        try:
            length = int(content_length)
        except ValueError:
            self._error(400, "invalid Content-Length")
            return None
        if length < 0:
            self._error(400, "invalid Content-Length")
            return None
        if length > MAX_BODY:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return None
        try:
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"), parse_constant=Store._bad_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(400, "malformed JSON")
            return None

    def _guard(self, operation: Any) -> None:
        try:
            operation()
        except (OSError, TypeError, ValueError) as exc:
            print(f"request failed: {exc}", file=sys.stderr)
            self._error(500, "persistence failure")

    def do_GET(self) -> None:
        path = self._route_path()
        if path is None:
            return
        if path == "/health":
            self._send_json(200, {"status": "ok"})
        elif path == "/v1/keys":
            self._guard(lambda: self._send_json(200, {"keys": self.store.keys()}))
        elif path.startswith(KEY_PREFIX):
            key = self._key_from_path(path)
            if key is None:
                return

            def get_value() -> None:
                present, value = self.store.get(key)
                if present:
                    self._send_json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")

            self._guard(get_value)
        else:
            self._error(404, "route not found")

    def do_PUT(self) -> None:
        path = self._route_path()
        if path is None:
            return
        if not path.startswith(KEY_PREFIX):
            self._error(404, "route not found")
            return
        key = self._key_from_path(path)
        if key is None:
            return
        body = self._read_json()
        if body is None:
            return
        if not isinstance(body, dict) or "value" not in body or not set(body) <= {"value", "ttl_seconds"}:
            self._error(400, "body must be an object with value and optional ttl_seconds")
            return
        ttl = body.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be finite and greater than zero")
            return

        def put_value() -> None:
            created = self.store.put(key, body["value"], float(ttl) if ttl is not None else None)
            self._send_json(201 if created else 200, {"key": key, "value": body["value"]})

        self._guard(put_value)

    def do_DELETE(self) -> None:
        path = self._route_path()
        if path is None:
            return
        if not path.startswith(KEY_PREFIX):
            self._error(404, "route not found")
            return
        key = self._key_from_path(path)
        if key is None:
            return

        def delete_value() -> None:
            if self.store.delete(key):
                self._send_json(204, None)
            else:
                self._error(404, "key not found")

        self._guard(delete_value)

    def _method_not_allowed(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        payload = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed


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
        server = Server((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
