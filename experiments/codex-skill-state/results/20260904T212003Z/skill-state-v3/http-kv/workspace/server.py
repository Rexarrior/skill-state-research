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

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                raw = json.load(source, parse_constant=self._reject_constant)
            if not isinstance(raw, dict) or raw.get("version") != 1:
                raise ValueError("unsupported data-file format")
            entries = raw.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("entries must be an object")

            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid key in data file")
                if not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("invalid entry in data file")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiry in data file")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}

            now = time.time()
            self.entries = {
                key: entry for key, entry in loaded.items() if self._is_live(entry, now)
            }
            if len(self.entries) != len(loaded):
                self._persist_locked(self.entries)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist_locked(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        temporary: str | None = None
        try:
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=parent)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(
                    {"version": 1, "entries": entries},
                    output,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
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
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist {self.path}: {exc}") from exc
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def _without_expired_locked(self, now: float) -> tuple[dict[str, dict[str, Any]], bool]:
        live = {
            key: entry for key, entry in self.entries.items() if self._is_live(entry, now)
        }
        return live, len(live) != len(self.entries)

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            live, _ = self._without_expired_locked(now)
            created = key not in live
            updated = dict(live)
            updated[key] = {
                "value": value,
                "expires_at": None if ttl is None else now + ttl,
            }
            self._persist_locked(updated)
            self.entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            live, changed = self._without_expired_locked(time.time())
            self.entries = live
            if changed:
                self._best_effort_persist_locked()
            entry = live.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            live, expired_changed = self._without_expired_locked(time.time())
            if key not in live:
                self.entries = live
                if expired_changed:
                    self._best_effort_persist_locked()
                return False
            updated = dict(live)
            del updated[key]
            self._persist_locked(updated)
            self.entries = updated
            return True

    def keys(self) -> list[str]:
        with self.lock:
            live, changed = self._without_expired_locked(time.time())
            self.entries = live
            if changed:
                self._best_effort_persist_locked()
            return sorted(live)

    def _best_effort_persist_locked(self) -> None:
        try:
            self._persist_locked(self.entries)
        except StoreError as exc:
            print(f"warning: {exc}", file=sys.stderr, flush=True)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "KVService/1.0"

    @property
    def kv_server(self) -> KVServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, fmt: str, *args: Any) -> None:
        print(
            f"{self.client_address[0]} - {fmt % args}",
            file=sys.stderr,
            flush=True,
        )

    def _json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
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

    def _route(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if parsed.path.startswith(prefix):
            raw_key = parsed.path[len(prefix) :]
            if not raw_key or "/" in raw_key or _BAD_PERCENT.search(raw_key):
                return "invalid-key", None
            try:
                key = unquote_to_bytes(raw_key).decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                return "invalid-key", None
            if not key or "/" in key:
                return "invalid-key", None
            return "kv", key
        return "unknown", None

    def _read_json(self) -> tuple[bool, Any]:
        if self.headers.get("Transfer-Encoding") is not None:
            self._error(400, "transfer encoding is not supported")
            self.close_connection = True
            return False, None
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1:
            self._error(411 if not lengths else 400, "a single Content-Length is required")
            self.close_connection = True
            return False, None
        try:
            length = int(lengths[0], 10)
        except ValueError:
            self._error(400, "invalid Content-Length")
            self.close_connection = True
            return False, None
        if length < 0:
            self._error(400, "invalid Content-Length")
            self.close_connection = True
            return False, None
        if length > MAX_BODY:
            self._error(413, "request body exceeds 1 MiB")
            self.close_connection = True
            return False, None
        body = self.rfile.read(length)
        if len(body) != length:
            self._error(400, "incomplete request body")
            self.close_connection = True
            return False, None
        try:
            return True, json.loads(
                body.decode("utf-8"), parse_constant=Store._reject_constant
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._error(400, "malformed JSON")
            return False, None

    def do_GET(self) -> None:
        route, key = self._route()
        if route == "health":
            self._json(200, {"status": "ok"})
        elif route == "keys":
            self._json(200, {"keys": self.kv_server.store.keys()})
        elif route == "kv":
            assert key is not None
            present, value = self.kv_server.store.get(key)
            if present:
                self._json(200, {"key": key, "value": value})
            else:
                self._error(404, "key not found")
        elif route == "invalid-key":
            self._error(400, "invalid key")
        else:
            self._error(404, "route not found")

    def do_PUT(self) -> None:
        route, key = self._route()
        if route != "kv":
            if route == "invalid-key":
                self._error(400, "invalid key")
            else:
                self._error(404, "route not found")
            self.close_connection = True
            return
        valid, body = self._read_json()
        if not valid:
            return
        if not isinstance(body, dict) or "value" not in body:
            self._error(400, "body must be an object containing value")
            return
        if set(body) - {"value", "ttl_seconds"}:
            self._error(400, "body contains unsupported fields")
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
        assert key is not None
        try:
            created = self.kv_server.store.put(key, body["value"], ttl)
        except StoreError as exc:
            print(f"error: {exc}", file=sys.stderr, flush=True)
            self._error(500, "persistence failure")
            return
        self._json(201 if created else 200, {"key": key, "value": body["value"]})

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "invalid-key":
            self._error(400, "invalid key")
            return
        if route != "kv":
            self._error(404, "route not found")
            return
        assert key is not None
        try:
            deleted = self.kv_server.store.delete(key)
        except StoreError as exc:
            print(f"error: {exc}", file=sys.stderr, flush=True)
            self._error(500, "persistence failure")
            return
        if deleted:
            self._empty(204)
        else:
            self._error(404, "key not found")

    def _unsupported(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


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
        server = KVServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"fatal: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop(signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            print(f"received signal {signum}; shutting down", file=sys.stderr, flush=True)
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    previous_term = signal.signal(signal.SIGTERM, stop)
    previous_int = signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGINT, previous_int)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
