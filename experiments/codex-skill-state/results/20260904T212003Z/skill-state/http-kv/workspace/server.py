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
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
VALID_ESCAPE = re.compile(r"%(?:[0-9A-Fa-f]{2})")


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is None or expires_at > now

    def _remove_expired_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if not self._is_live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                document = json.load(stream, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            raw_entries = document.get("entries") if isinstance(document, dict) else None
            if not isinstance(raw_entries, dict):
                raise ValueError("top-level object must contain an entries object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key or not isinstance(entry, dict):
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
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
            if self._remove_expired_locked():
                self._persist_locked()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    def _persist_locked(self) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(
                        {"entries": self.entries},
                        stream,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                    )
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary_name, self.path)
                temporary_name = ""
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    pass
            finally:
                if temporary_name:
                    try:
                        os.unlink(temporary_name)
                    except FileNotFoundError:
                        pass
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            changed = self._remove_expired_locked()
            if changed:
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self.lock:
            self._remove_expired_locked()
            existed = key in self.entries
            old_entry = self.entries.get(key)
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                if old_entry is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = old_entry
                raise
            return existed

    def delete(self, key: str) -> bool:
        with self.lock:
            self._remove_expired_locked()
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
            if self._remove_expired_locked():
                self._persist_locked()
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

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}", file=sys.stderr)

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _key_from_path(self, path: str) -> str | None:
        if not path.startswith(KEY_PREFIX):
            return None
        encoded = path[len(KEY_PREFIX) :]
        index = 0
        while True:
            index = encoded.find("%", index)
            if index < 0:
                break
            if VALID_ESCAPE.match(encoded, index) is None:
                raise ValueError("key contains an invalid URL escape")
            index += 3
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ValueError("key is not valid UTF-8") from exc
        if not key:
            raise ValueError("key must not be empty")
        if "/" in key:
            raise ValueError("key must not contain '/'")
        return key

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
        raw = self.rfile.read(length)
        try:
            return json.loads(
                raw.decode("utf-8"),
                parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            raise RequestError(400, "malformed JSON") from exc

    def _dispatch(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            if self.command != "GET":
                self._method_not_allowed("GET")
            else:
                self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            if self.command != "GET":
                self._method_not_allowed("GET")
            else:
                self._send_json(200, {"keys": self.server.store.keys()})
            return
        if path.startswith(KEY_PREFIX):
            try:
                key = self._key_from_path(path)
            except ValueError as exc:
                self._error(400, str(exc))
                return
            if self.command == "GET":
                found, value = self.server.store.get(key)
                if found:
                    self._send_json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            elif self.command == "PUT":
                self._put(key)
            elif self.command == "DELETE":
                if self.server.store.delete(key):
                    self.send_response(204)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self._error(404, "key not found")
            else:
                self._method_not_allowed("GET, PUT, DELETE")
            return
        self._error(404, "route not found")

    def _method_not_allowed(self, allowed: str) -> None:
        body = json.dumps({"error": "method not allowed"}, separators=(",", ":")).encode("utf-8")
        self.send_response(405)
        self.send_header("Allow", allowed)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _put(self, key: str) -> None:
        payload = self._read_json()
        if not isinstance(payload, dict) or "value" not in payload or not set(payload).issubset({"value", "ttl_seconds"}):
            raise RequestError(400, "body must be an object containing value and optional ttl_seconds")
        ttl = payload.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            raise RequestError(400, "ttl_seconds must be a finite number greater than zero")
        replaced = self.server.store.put(key, payload["value"], ttl)
        self._send_json(200 if replaced else 201, {"key": key, "value": payload["value"]})

    def _handle(self) -> None:
        try:
            self._dispatch()
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except StoreError as exc:
            print(str(exc), file=sys.stderr)
            self._error(500, "persistent storage error")
        except (BrokenPipeError, ConnectionResetError):
            pass

    do_GET = _handle
    do_PUT = _handle
    do_DELETE = _handle
    do_POST = _handle
    do_PATCH = _handle
    do_HEAD = _handle
    do_OPTIONS = _handle


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


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
        print(f"startup failed: {exc}", file=sys.stderr)
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
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
