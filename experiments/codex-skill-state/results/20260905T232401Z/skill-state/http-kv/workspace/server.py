#!/usr/bin/env python3
"""A small, persistent HTTP key-value service."""

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
VALID_ESCAPE = re.compile(r"%[0-9A-Fa-f]{2}")


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


class Store:
    """Lock-protected store whose mutations are durably replaced on disk."""

    def __init__(self, data_path: Path) -> None:
        self.path = data_path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists() or self.path.stat().st_size == 0:
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=_reject_json_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("data file has no entries object")

            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError("invalid entry in data file")
                if set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid entry fields in data file")
                expires_at = entry["expires_at"]
                if expires_at is not None:
                    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
                        raise ValueError("invalid expiration in data file")
                    if not math.isfinite(expires_at):
                        raise ValueError("non-finite expiration in data file")
                    if expires_at <= now:
                        continue
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
        except (OSError, ValueError, TypeError, RecursionError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        # Rewrite once after startup so expired records are physically removed.
        if len(loaded) != len(raw_entries):
            self._persist_locked()

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
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
            os.replace(temporary_name, self.path)
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some filesystems do not support syncing directory descriptors.
                pass
        except BaseException:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    def _prune_locked(self, now: float) -> bool:
        expired = [
            key
            for key, entry in self.entries.items()
            if entry["expires_at"] is not None and entry["expires_at"] <= now
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_prune_locked(self, now: float) -> None:
        if self._prune_locked(now):
            self._persist_locked()

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._persist_prune_locked(now)
            created = key not in self.entries
            previous = self.entries.get(key)
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            self.entries[key] = {"value": value, "expires_at": expires_at}
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
            self._persist_prune_locked(time.time())
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            self._persist_prune_locked(time.time())
            previous = self.entries.get(key)
            if previous is None:
                return False
            del self.entries[key]
            try:
                self._persist_locked()
            except BaseException:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._persist_prune_locked(time.time())
            return sorted(self.entries)


def decode_key(encoded: str) -> str:
    if not encoded:
        raise RequestError(400, "key must not be empty")
    index = 0
    while index < len(encoded):
        if encoded[index] == "%":
            match = VALID_ESCAPE.match(encoded, index)
            if match is None:
                raise RequestError(400, "key has invalid percent encoding")
            index += 3
        else:
            index += 1
    try:
        key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise RequestError(400, "key is not valid UTF-8") from exc
    if not key:
        raise RequestError(400, "key must not be empty")
    if "/" in key:
        raise RequestError(400, "key must not contain '/'")
    return key


class KVHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined,no-any-return]

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] " + format_string % args,
            file=sys.stderr,
        )

    def _send_json(self, status: int, payload: Any | None = None) -> None:
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _path(self) -> str:
        try:
            return urlsplit(self.path).path
        except ValueError as exc:
            raise RequestError(400, "invalid request target") from exc

    def _route_key(self) -> str:
        path = self._path()
        if not path.startswith(KEY_PREFIX):
            raise RequestError(404, "route not found")
        encoded_key = path[len(KEY_PREFIX) :]
        if "/" in encoded_key:
            raise RequestError(400, "key must not contain '/'")
        return decode_key(encoded_key)

    def _read_json(self) -> Any:
        lengths = self.headers.get_all("Content-Length", failobj=[])
        if len(lengths) != 1:
            raise RequestError(400, "exactly one Content-Length header is required")
        try:
            length = int(lengths[0], 10)
        except (TypeError, ValueError) as exc:
            raise RequestError(400, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        if len(body) != length:
            raise RequestError(400, "incomplete request body")
        try:
            return json.loads(body, parse_constant=_reject_json_constant)
        except (ValueError, UnicodeDecodeError, RecursionError) as exc:
            raise RequestError(400, "malformed JSON") from exc

    def _handle(self, action: Any) -> None:
        try:
            action()
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._error(500, "internal server error")

    def do_GET(self) -> None:
        self._handle(self._do_get)

    def _do_get(self) -> None:
        path = self._path()
        if path == "/health":
            self._send_json(200, {"status": "ok"})
        elif path == "/v1/keys":
            self._send_json(200, {"keys": self.store.keys()})
        elif path.startswith(KEY_PREFIX):
            key = self._route_key()
            found, value = self.store.get(key)
            if not found:
                self._error(404, "key not found")
            else:
                self._send_json(200, {"key": key, "value": value})
        else:
            self._error(404, "route not found")

    def do_PUT(self) -> None:
        self._handle(self._do_put)

    def _do_put(self) -> None:
        key = self._route_key()
        payload = self._read_json()
        if not isinstance(payload, dict):
            raise RequestError(400, "request JSON must be an object")
        if "value" not in payload:
            raise RequestError(400, "request JSON must contain 'value'")
        if not set(payload).issubset({"value", "ttl_seconds"}):
            raise RequestError(400, "request JSON contains unknown fields")

        ttl: float | None = None
        if "ttl_seconds" in payload:
            raw_ttl = payload["ttl_seconds"]
            if isinstance(raw_ttl, bool) or not isinstance(raw_ttl, (int, float)):
                raise RequestError(400, "ttl_seconds must be a number")
            try:
                ttl = float(raw_ttl)
            except OverflowError as exc:
                raise RequestError(400, "ttl_seconds must be finite and greater than zero") from exc
            if not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
                raise RequestError(400, "ttl_seconds must be finite and greater than zero")

        created = self.store.put(key, payload["value"], ttl)
        self._send_json(201 if created else 200, {"key": key, "value": payload["value"]})

    def do_DELETE(self) -> None:
        self._handle(self._do_delete)

    def _do_delete(self) -> None:
        key = self._route_key()
        if self.store.delete(key):
            self._send_json(204)
        else:
            self._error(404, "key not found")

    def _method_not_allowed(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed


class KVHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, KVHandler)


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
        server = KVHTTPServer((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"startup error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, name="shutdown", daemon=True).start()

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
