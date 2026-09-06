#!/usr/bin/env python3
"""A small persistent HTTP key-value service."""

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


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Store:
    """Lock-protected store whose mutations are durably committed."""

    def __init__(self, path: Path):
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
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle, parse_constant=self._invalid_constant)
            if not isinstance(raw, dict) or raw.get("version") != 1:
                raise ValueError("unsupported data-file format")
            entries = raw.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("invalid entries in data file")
            loaded: dict[str, dict[str, Any]] = {}
            now = time.time()
            for key, entry in entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError("invalid entry in data file")
                if set(entry) - {"value", "expires_at"} or "value" not in entry:
                    raise ValueError("invalid entry in data file")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiry in data file")
                if self._live(entry, now):
                    loaded[key] = entry
            self.entries = loaded
            if len(loaded) != len(entries):
                self._persist()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _invalid_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd = -1
        temporary: str | None = None
        try:
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=parent)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                fd = -1
                json.dump(
                    {"version": 1, "entries": self.entries},
                    handle,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
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
        finally:
            if fd >= 0:
                os.close(fd)
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def _purge(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._purge(now)
            created = key not in self.entries
            old = self.entries.get(key)
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl is None else now + ttl,
            }
            try:
                self._persist()
            except Exception:
                if old is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = old
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            now = time.time()
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if not self._live(entry, now):
                del self.entries[key]
                self._persist()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            now = time.time()
            entry = self.entries.get(key)
            if entry is None:
                return False
            if not self._live(entry, now):
                del self.entries[key]
                self._persist()
                return False
            del self.entries[key]
            try:
                self._persist()
            except Exception:
                self.entries[key] = entry
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge(time.time()):
                self._persist()
            return sorted(self.entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "kv-service"
    sys_version = ""

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined,no-any-return]

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def _json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    @staticmethod
    def _key(path: str) -> str | None:
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix):]
        if not encoded or "/" in encoded:
            raise RequestError(400, "invalid key")
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                if index + 2 >= len(encoded) or any(c not in "0123456789abcdefABCDEF" for c in encoded[index + 1:index + 3]):
                    raise RequestError(400, "invalid URL encoding")
                index += 3
            else:
                index += 1
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RequestError(400, "key must be valid UTF-8") from exc
        if not key or "/" in key:
            raise RequestError(400, "invalid key")
        return key

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _body(self) -> dict[str, Any]:
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(400, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise RequestError(400, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            # Consume at most one byte beyond the limit.  This drains the
            # common MAX_BODY + 1 case so the peer receives the JSON 413
            # response instead of a TCP reset, while still bounding the work
            # an attacker can cause with an enormous Content-Length.
            self.rfile.read(MAX_BODY + 1)
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            value = json.loads(body.decode("utf-8"), parse_constant=Store._invalid_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            raise RequestError(400, "malformed JSON") from exc
        if not isinstance(value, dict):
            raise RequestError(400, "request body must be a JSON object")
        return value

    def _dispatch(self) -> None:
        path = self._path()
        if path == "/health":
            if self.command == "GET":
                self._json(200, {"status": "ok"})
            else:
                self._error(405, "method not allowed")
            return
        if path == "/v1/keys":
            if self.command == "GET":
                self._json(200, {"keys": self.store.keys()})
            else:
                self._error(405, "method not allowed")
            return
        key = self._key(path)
        if key is None:
            self._error(404, "route not found")
            return
        if self.command == "GET":
            found, value = self.store.get(key)
            if found:
                self._json(200, {"key": key, "value": value})
            else:
                self._error(404, "key not found")
            return
        if self.command == "DELETE":
            if self.store.delete(key):
                self._empty(204)
            else:
                self._error(404, "key not found")
            return
        if self.command == "PUT":
            body = self._body()
            if "value" not in body or set(body) - {"value", "ttl_seconds"}:
                raise RequestError(400, "body must contain value and optional ttl_seconds")
            ttl = body.get("ttl_seconds")
            if ttl is not None:
                if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0:
                    raise RequestError(400, "ttl_seconds must be a finite number greater than zero")
                ttl = float(ttl)
            created = self.store.put(key, body["value"], ttl)
            self._json(201 if created else 200, {"key": key, "value": body["value"]})
            return
        self._error(405, "method not allowed")

    def _handle(self) -> None:
        try:
            self._dispatch()
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._error(500, "internal server error")

    do_GET = _handle
    do_PUT = _handle
    do_DELETE = _handle
    do_POST = _handle
    do_PATCH = _handle
    do_HEAD = _handle
    do_OPTIONS = _handle


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
        server = KVServer((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"fatal: {exc}", file=sys.stderr)
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
