#!/usr/bin/env python3
"""A small persistent HTTP key-value service using only the standard library."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_SIZE = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(Exception):
    """Raised when persistent state cannot be read or written."""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._reject_constant)
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("invalid top-level structure")
            loaded: dict[str, dict[str, Any]] = {}
            removed_expired = False
            now = time.time()
            for key, entry in raw_entries.items():
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
                normalized = {"value": entry["value"], "expires_at": expires_at}
                if self._live(normalized, now):
                    loaded[key] = normalized
                else:
                    removed_expired = True
            self.entries = loaded
            if removed_expired:
                self._persist_locked()
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number: {value}")

    def _purge_locked(self) -> None:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        if expired:
            for key in expired:
                del self.entries[key]
            self._persist_locked()

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd = -1
        temporary = ""
        try:
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                fd = -1
                json.dump({"entries": self.entries}, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            temporary = ""
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some platforms/filesystems do not permit syncing directories.
                pass
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if fd >= 0:
                os.close(fd)
            if temporary:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked()
            existed = key in self.entries
            old_entry = self.entries.get(key)
            expires_at = None if ttl is None else time.time() + ttl
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                if old_entry is None:
                    del self.entries[key]
                else:
                    self.entries[key] = old_entry
                raise
            return existed

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._purge_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked()
            old_entry = self.entries.pop(key, None)
            if old_entry is None:
                return False
            try:
                self._persist_locked()
            except StoreError:
                self.entries[key] = old_entry
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._purge_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        super().__init__(address, Handler)
        self.store = store


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        # BaseHTTPRequestHandler logs to stderr; keep stdout reserved for LISTENING.
        super().log_message(format, *args)

    def _send_json(self, status: int, payload: Any, *, send_body: bool = True) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if send_body:
            self.wfile.write(encoded)

    def _error(self, status: int, message: str, *, send_body: bool = True) -> None:
        self._send_json(status, {"error": message}, send_body=send_body)

    def _key(self, path: str) -> tuple[str | None, str | None]:
        if not path.startswith(KEY_PREFIX):
            return None, "route"
        encoded = path[len(KEY_PREFIX):]
        if not encoded or "/" in encoded or BAD_ESCAPE.search(encoded):
            return None, "invalid key"
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return None, "invalid key"
        if not key or "/" in key:
            return None, "invalid key"
        return key, None

    def _read_json(self) -> tuple[Any, str | None, int | None]:
        if self.headers.get("Transfer-Encoding") is not None:
            return None, "transfer encoding is not supported", 400
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return None, "Content-Length is required", 411
        try:
            length = int(raw_length, 10)
        except ValueError:
            return None, "invalid Content-Length", 400
        if length < 0:
            return None, "invalid Content-Length", 400
        if length > MAX_BODY_SIZE:
            # Consume the request before replying.  Responding while a client is
            # still uploading commonly makes it see BrokenPipe instead of the
            # useful 413 response; drain in chunks so oversized bodies are never
            # retained in memory.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    return None, "incomplete request body", 400
                remaining -= len(chunk)
            return None, "request body exceeds 1 MiB", 413
        body = self.rfile.read(length)
        if len(body) != length:
            return None, "incomplete request body", 400
        try:
            parsed = json.loads(body.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            return None, "malformed JSON", 400
        return parsed, None, None

    def _path(self) -> str:
        return urlsplit(self.path).path

    def do_GET(self) -> None:
        path = self._path()
        if path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            try:
                keys = self.server.store.keys()
            except StoreError as exc:
                self.log_error("%s", exc)
                self._error(500, "storage error")
                return
            self._send_json(200, {"keys": keys})
            return
        key, problem = self._key(path)
        if problem == "route":
            self._error(404, "unknown route")
            return
        if problem:
            self._error(400, problem)
            return
        try:
            found, value = self.server.store.get(key)
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "storage error")
            return
        if not found:
            self._error(404, "key not found")
            return
        self._send_json(200, {"key": key, "value": value})

    def do_PUT(self) -> None:
        key, problem = self._key(self._path())
        if problem == "route":
            self._error(404, "unknown route")
            return
        if problem:
            self._error(400, problem)
            return
        document, message, status = self._read_json()
        if message:
            self._error(status or 400, message)
            return
        if not isinstance(document, dict) or "value" not in document or not set(document) <= {"value", "ttl_seconds"}:
            self._error(400, "body must be an object containing value and optional ttl_seconds")
            return
        ttl = document.get("ttl_seconds")
        if "ttl_seconds" in document and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            replaced = self.server.store.put(key, document["value"], ttl)
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "storage error")
            return
        self._send_json(200 if replaced else 201, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        key, problem = self._key(self._path())
        if problem == "route":
            self._error(404, "unknown route")
            return
        if problem:
            self._error(400, problem)
            return
        try:
            deleted = self.server.store.delete(key)
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "storage error")
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unsupported(self, send_body: bool = True) -> None:
        path = self._path()
        key, problem = self._key(path)
        known = path in {"/health", "/v1/keys"} or problem != "route"
        if not known:
            self._error(404, "unknown route", send_body=send_body)
            return
        del key
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        encoded = json.dumps({"error": "method not allowed"}, separators=(",", ":")).encode()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if send_body:
            self.wfile.write(encoded)

    def do_POST(self) -> None:
        self._unsupported()

    def do_PATCH(self) -> None:
        self._unsupported()

    def do_OPTIONS(self) -> None:
        self._unsupported()

    def do_HEAD(self) -> None:
        self._unsupported(send_body=False)


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
    except (OSError, StoreError) as exc:
        print(f"startup error: {exc}", file=os.sys.stderr)
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
