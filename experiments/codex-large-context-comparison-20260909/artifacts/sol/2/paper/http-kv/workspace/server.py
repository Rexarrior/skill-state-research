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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_expired(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is not None and expires_at <= now

    def _remove_expired_locked(self) -> bool:
        now = time.time()
        expired = [
            key for key, entry in self.entries.items()
            if self._is_expired(entry, now)
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or set(document) != {"entries"}:
                raise ValueError("top-level object must contain only 'entries'")
            entries = document["entries"]
            if not isinstance(entries, dict):
                raise ValueError("'entries' must be an object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid stored key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid stored entry")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid stored expiration")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
            if self._remove_expired_locked():
                self._persist_locked()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist_locked(self) -> None:
        parent = self.path.parent
        temporary: str | None = None
        try:
            parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(
                    {"entries": self.entries}, output,
                    ensure_ascii=False, allow_nan=False, separators=(",", ":"),
                )
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            temporary = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Directory fsync is unavailable on some platforms/filesystems.
                pass
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def _prune_locked(self) -> None:
        if self._remove_expired_locked():
            try:
                self._persist_locked()
            except StoreError as exc:
                print(f"warning: {exc}", file=sys.stderr, flush=True)

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._remove_expired_locked()
            existed = key in self.entries
            old_entries = self.entries.copy()
            expires_at = None if ttl is None else time.time() + ttl
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                self.entries = old_entries
                raise
            return existed

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._prune_locked()
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            self._remove_expired_locked()
            if key not in self.entries:
                return False
            old_entry = self.entries.pop(key)
            try:
                self._persist_locked()
            except StoreError:
                self.entries[key] = old_entry
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._prune_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        super().__init__(address, Handler)
        self.store = store


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - {format_string % args}",
            file=sys.stderr,
            flush=True,
        )

    def __getattr__(self, name: str) -> Any:
        if name.startswith("do_"):
            return self._unsupported_method
        raise AttributeError(name)

    def _send_json(self, status: int, body: Any) -> None:
        encoded = json.dumps(
            body, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _unsupported_method(self) -> None:
        self._error(405, "method not allowed")

    def _path(self) -> str | None:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self._error(400, "invalid URL")
            return None
        if parsed.query or parsed.fragment:
            self._error(404, "route not found")
            return None
        return parsed.path

    def _key(self, path: str) -> str | None:
        if not path.startswith(KEY_PREFIX):
            self._error(404, "route not found")
            return None
        encoded_key = path[len(KEY_PREFIX):]
        if not encoded_key or "/" in encoded_key or BAD_PERCENT_ESCAPE.search(encoded_key):
            self._error(400, "invalid key")
            return None
        try:
            key = unquote_to_bytes(encoded_key).decode("utf-8")
        except UnicodeDecodeError:
            self._error(400, "key must be valid UTF-8")
            return None
        if not key or "/" in key:
            self._error(400, "invalid key")
            return None
        return key

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            self._error(400, "transfer encoding is not supported")
            return _INVALID
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "Content-Length is required")
            return _INVALID
        try:
            length = int(raw_length)
        except ValueError:
            self._error(400, "invalid Content-Length")
            return _INVALID
        if length < 0:
            self._error(400, "invalid Content-Length")
            return _INVALID
        if length > MAX_BODY:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return _INVALID
        raw = self.rfile.read(length)
        if len(raw) != length:
            self.close_connection = True
            self._error(400, "incomplete request body")
            return _INVALID
        try:
            return json.loads(raw.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(400, "malformed JSON")
            return _INVALID

    def do_GET(self) -> None:
        path = self._path()
        if path is None:
            return
        if path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            self._send_json(200, {"keys": self.server.store.keys()})
            return
        key = self._key(path)
        if key is None:
            return
        present, value = self.server.store.get(key)
        if not present:
            self._error(404, "key not found")
            return
        self._send_json(200, {"key": key, "value": value})

    def do_PUT(self) -> None:
        path = self._path()
        if path is None:
            return
        key = self._key(path)
        if key is None:
            return
        body = self._read_json()
        if body is _INVALID:
            return
        if not isinstance(body, dict) or "value" not in body:
            self._error(400, "body must be an object containing 'value'")
            return
        if not set(body).issubset({"value", "ttl_seconds"}):
            self._error(400, "body contains unknown fields")
            return
        ttl = body.get("ttl_seconds")
        if ttl is not None:
            if (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
                or not math.isfinite(time.time() + ttl)
            ):
                self._error(400, "ttl_seconds must be finite and greater than zero")
                return
            ttl = float(ttl)
        try:
            replaced = self.server.store.put(key, body["value"], ttl)
        except StoreError as exc:
            print(str(exc), file=sys.stderr, flush=True)
            self._error(500, "could not persist value")
            return
        self._send_json(200 if replaced else 201, {"key": key, "value": body["value"]})

    def do_DELETE(self) -> None:
        path = self._path()
        if path is None:
            return
        key = self._key(path)
        if key is None:
            return
        try:
            deleted = self.server.store.delete(key)
        except StoreError as exc:
            print(str(exc), file=sys.stderr, flush=True)
            self._error(500, "could not persist deletion")
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


_INVALID = object()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
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
    except (StoreError, OSError) as exc:
        print(f"startup error: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
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
