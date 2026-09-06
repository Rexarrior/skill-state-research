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
VALID_PERCENT_ESCAPE = re.compile(r"%(?:[0-9A-Fa-f]{2})")


class Store:
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
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._bad_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported persistence format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("entries must be an object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid persisted key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid persisted entry")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid persisted expiry")
                loaded[key] = entry
            self.entries = loaded
            if self._purge_locked(time.time()):
                self._persist_locked()
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _bad_constant(value: str) -> None:
        raise ValueError(f"non-finite number {value}")

    def _purge_locked(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    {"version": 1, "entries": self.entries},
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
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._purge_locked(now)
            created = key not in self.entries
            previous = self.entries.get(key)
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl is None else now + ttl,
            }
            try:
                self._persist_locked()
            except BaseException:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if not self._live(entry, time.time()):
                del self.entries[key]
                self._persist_locked()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False
            if not self._live(entry, time.time()):
                del self.entries[key]
                self._persist_locked()
                return False
            del self.entries[key]
            try:
                self._persist_locked()
            except BaseException:
                self.entries[key] = entry
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_locked(time.time()):
                self._persist_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.client_address[0]} - {format % args}", file=sys.stderr)

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

    def _route_key(self) -> tuple[bool, str | None]:
        path = urlsplit(self.path).path
        if not path.startswith(KEY_PREFIX):
            return False, None
        encoded = path[len(KEY_PREFIX) :]
        # urllib accepts malformed percent escapes, so reject them explicitly.
        without_escapes = VALID_PERCENT_ESCAPE.sub("", encoded)
        if "%" in without_escapes:
            self._error(400, "invalid percent-encoding in key")
            return True, None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            self._error(400, "key must be valid UTF-8")
            return True, None
        if not key or "/" in key:
            self._error(400, "key must be non-empty and must not contain '/'")
            return True, None
        return True, key

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(400, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(raw_length, 10)
        except ValueError:
            raise RequestError(400, "invalid Content-Length") from None
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            # Consume the request before replying so clients that are still
            # transmitting it do not see a reset/broken pipe.  Drain in
            # bounded chunks: the size limit must not itself cause a large
            # allocation.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            return json.loads(body, parse_constant=self._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise RequestError(400, "malformed JSON") from None

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(value)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        try:
            if path == "/health":
                self._json(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._json(200, {"keys": self.server.store.keys()})
                return
            matched, key = self._route_key()
            if matched:
                if key is None:
                    return
                found, value = self.server.store.get(key)
                if found:
                    self._json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
                return
            self._error(404, "route not found")
        except OSError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        matched, key = self._route_key()
        if not matched:
            self._error(404, "route not found")
            return
        if key is None:
            return
        try:
            document = self._read_json()
            if not isinstance(document, dict) or "value" not in document:
                raise RequestError(400, "body must be an object containing 'value'")
            if set(document) - {"value", "ttl_seconds"}:
                raise RequestError(400, "body contains unknown fields")
            ttl = document.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(400, "ttl_seconds must be finite and greater than zero")
            created = self.server.store.put(key, document["value"], ttl)
            self._json(201 if created else 200, {"key": key, "value": document["value"]})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except OSError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_DELETE(self) -> None:
        matched, key = self._route_key()
        if not matched:
            self._error(404, "route not found")
            return
        if key is None:
            return
        try:
            if self.server.store.delete(key):
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self._error(404, "key not found")
        except OSError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def _method_not_allowed(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
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
    except (OSError, RuntimeError) as exc:
        print(f"startup error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(signum: int, frame: Any) -> None:
        del signum, frame
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
