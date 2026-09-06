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
_BAD_PERCENT = re.compile(r"%(?![0-9A-Fa-f]{2})")


class Store:
    """Thread-safe in-memory state backed by an atomically replaced JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as source:
            document = json.load(source, parse_constant=self._reject_constant)
        if not isinstance(document, dict) or document.get("version") != 1:
            raise ValueError("unsupported data file format")
        entries = document.get("entries")
        if not isinstance(entries, dict):
            raise ValueError("invalid entries in data file")

        now = time.time()
        loaded: dict[str, dict[str, Any]] = {}
        removed_expired = False
        for key, entry in entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise ValueError("invalid key in data file")
            if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                raise ValueError("invalid entry in data file")
            expires_at = entry["expires_at"]
            if expires_at is not None:
                if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
                    raise ValueError("invalid expiration in data file")
                expires_at = float(expires_at)
                if not math.isfinite(expires_at):
                    raise ValueError("invalid expiration in data file")
                if expires_at <= now:
                    removed_expired = True
                    continue
            loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        self.entries = loaded
        if removed_expired:
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(
                    {"version": 1, "entries": self.entries},
                    output,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
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
        except Exception:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    @staticmethod
    def _is_expired(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is not None and expires_at <= now

    def _remove_expired_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if self._is_expired(entry, now)]
        if not expired:
            return False
        for key in expired:
            del self.entries[key]
        self._persist_locked()
        return True

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        expires_at = None if ttl is None else time.time() + ttl
        if expires_at is not None and not math.isfinite(expires_at):
            raise ValueError("ttl_seconds is too large")
        with self.lock:
            old = self.entries.get(key)
            created = old is None or self._is_expired(old, time.time())
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except Exception:
                if old is None:
                    del self.entries[key]
                else:
                    self.entries[key] = old
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if self._is_expired(entry, time.time()):
                del self.entries[key]
                self._persist_locked()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False
            if self._is_expired(entry, time.time()):
                del self.entries[key]
                self._persist_locked()
                return False
            del self.entries[key]
            try:
                self._persist_locked()
            except Exception:
                self.entries[key] = entry
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._remove_expired_locked()
            return sorted(self.entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: KVServer

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))
        sys.stderr.flush()

    def _send_json(self, status: int, body: Any) -> None:
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        self._error(code, message or self.responses.get(code, ("Error",))[0])

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _key(self) -> tuple[str | None, str | None]:
        path = self._path()
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None, "unknown route"
        encoded = path[len(prefix) :]
        if not encoded:
            return None, "key must not be empty"
        if "/" in encoded:
            return None, "key must not contain '/'"
        if _BAD_PERCENT.search(encoded):
            return None, "key has invalid percent encoding"
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return None, "key must be valid UTF-8"
        if not key:
            return None, "key must not be empty"
        if "/" in key:
            return None, "key must not contain '/'"
        return key, None

    def _read_json(self) -> tuple[Any | None, str | None, int]:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            return None, "transfer encoding is not supported", 400
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return None, "Content-Length is required", 411
        try:
            length = int(raw_length, 10)
        except ValueError:
            self.close_connection = True
            return None, "invalid Content-Length", 400
        if length < 0:
            self.close_connection = True
            return None, "invalid Content-Length", 400
        if length > MAX_BODY:
            self.close_connection = True
            return None, "request body exceeds 1 MiB", 413
        body = self.rfile.read(length)
        try:
            return json.loads(body, parse_constant=Store._reject_constant), None, 200
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            return None, "malformed JSON", 400

    def do_GET(self) -> None:
        path = self._path()
        if path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            try:
                keys = self.server.store.keys()
            except OSError:
                self.log_error("failed to persist expiration cleanup", exc_info=True)
                self._error(500, "storage error")
                return
            self._send_json(200, {"keys": keys})
            return
        key, error = self._key()
        if key is None:
            self._error(400 if path.startswith("/v1/kv/") else 404, error or "invalid key")
            return
        try:
            found, value = self.server.store.get(key)
        except OSError:
            self.log_error("failed to persist expiration cleanup")
            self._error(500, "storage error")
            return
        if not found:
            self._error(404, "key not found")
            return
        self._send_json(200, {"key": key, "value": value})

    def do_PUT(self) -> None:
        path = self._path()
        key, error = self._key()
        if key is None:
            self._error(400 if path.startswith("/v1/kv/") else 404, error or "invalid key")
            return
        document, error, status = self._read_json()
        if error is not None:
            self._error(status, error)
            return
        if not isinstance(document, dict):
            self._error(400, "body must be a JSON object")
            return
        if "value" not in document or not set(document).issubset({"value", "ttl_seconds"}):
            self._error(400, "body must contain value and optional ttl_seconds")
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None:
            if isinstance(ttl, bool) or not isinstance(ttl, (int, float)):
                self._error(400, "ttl_seconds must be a number")
                return
            try:
                ttl = float(ttl)
            except OverflowError:
                self._error(400, "ttl_seconds must be finite and greater than zero")
                return
            if not math.isfinite(ttl) or ttl <= 0:
                self._error(400, "ttl_seconds must be finite and greater than zero")
                return
        try:
            created = self.server.store.put(key, document["value"], ttl)
        except ValueError as exc:
            self._error(400, str(exc))
            return
        except (OSError, TypeError, OverflowError):
            self.log_error("failed to persist value")
            self._error(500, "storage error")
            return
        self._send_json(201 if created else 200, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        path = self._path()
        key, error = self._key()
        if key is None:
            self._error(400 if path.startswith("/v1/kv/") else 404, error or "invalid key")
            return
        try:
            deleted = self.server.store.delete(key)
        except OSError:
            self.log_error("failed to persist deletion")
            self._error(500, "storage error")
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unsupported(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported
    do_TRACE = _unsupported
    do_CONNECT = _unsupported


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
        server = KVServer((args.host, args.port), store)
    except Exception as exc:
        print(f"startup failed: {exc}", file=sys.stderr, flush=True)
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
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
