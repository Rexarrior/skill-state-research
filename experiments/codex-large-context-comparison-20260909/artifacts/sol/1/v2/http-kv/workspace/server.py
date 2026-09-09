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
VALID_PERCENT_ENCODING = re.compile(r"%(?![0-9A-Fa-f]{2})")


class Store:
    """Thread-safe store whose mutations are committed atomically to disk."""

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
                raise ValueError("unsupported data-file format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("invalid entries in data file")
            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError("invalid entry in data file")
                if "value" not in entry:
                    raise ValueError("entry has no value")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiry in data file")
                normalized = {"value": entry["value"], "expires_at": expires_at}
                if self._live(normalized, now):
                    loaded[key] = normalized
            self.entries = loaded
            if len(loaded) != len(raw_entries):
                self._persist_locked()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"could not load data file {self.path}: {exc}") from exc

    @staticmethod
    def _bad_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        document = {"version": 1, "entries": self.entries}
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(document, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
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
            self._purge_locked()
            existed = key in self.entries
            previous = self.entries.get(key)
            expires_at = time.time() + ttl if ttl is not None else None
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except BaseException:
                if previous is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = previous
                raise
            return existed

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            purged = self._purge_locked()
            if purged:
                self._persist_best_effort_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked()
            previous = self.entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist_locked()
            except BaseException:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            purged = self._purge_locked()
            if purged:
                self._persist_best_effort_locked()
            return sorted(self.entries)

    def flush(self) -> None:
        with self.lock:
            self._purge_locked()
            self._persist_locked()

    def _persist_best_effort_locked(self) -> None:
        try:
            self._persist_locked()
        except OSError as exc:
            print(f"warning: could not persist expiry cleanup: {exc}", file=sys.stderr)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _json(self, status: int, payload: Any, headers: dict[str, str] | None = None) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        if headers:
            for name, value in headers.items():
                self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD" and encoded:
            self.wfile.write(encoded)

    def _error(self, status: int, message: str, headers: dict[str, str] | None = None) -> None:
        self._json(status, {"error": message}, headers)

    def _route(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        if parsed.path.startswith(KEY_PREFIX):
            encoded = parsed.path[len(KEY_PREFIX):]
            if not encoded or "/" in encoded or VALID_PERCENT_ENCODING.search(encoded):
                return "bad_key", None
            try:
                key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                return "bad_key", None
            if not key or "/" in key:
                return "bad_key", None
            return "key", key
        return "unknown", None

    def _read_json(self) -> tuple[bool, Any]:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "Content-Length is required")
            return False, None
        try:
            length = int(raw_length)
        except ValueError:
            self._error(400, "invalid Content-Length")
            return False, None
        if length < 0:
            self._error(400, "invalid Content-Length")
            return False, None
        if length > MAX_BODY:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return False, None
        try:
            body = self.rfile.read(length)
            value = json.loads(body.decode("utf-8"), parse_constant=Store._bad_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(400, "malformed JSON")
            return False, None
        return True, value

    def do_GET(self) -> None:
        route, key = self._route()
        if route == "health":
            self._json(200, {"status": "ok"})
        elif route == "keys":
            self._json(200, {"keys": self.server.store.keys()})
        elif route == "key":
            found, value = self.server.store.get(key or "")
            if found:
                self._json(200, {"key": key, "value": value})
            else:
                self._error(404, "key not found")
        elif route == "bad_key":
            self._error(400, "invalid key")
        else:
            self._error(404, "route not found")

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "bad_key":
            self._error(400, "invalid key")
            return
        if route != "key":
            self._error(404, "route not found")
            return
        ok, document = self._read_json()
        if not ok:
            return
        if not isinstance(document, dict) or "value" not in document or not set(document).issubset({"value", "ttl_seconds"}):
            self._error(400, "body must be an object containing value and optional ttl_seconds")
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be finite and greater than zero")
            return
        try:
            replaced = self.server.store.put(key or "", document["value"], float(ttl) if ttl is not None else None)
        except (OSError, TypeError, ValueError) as exc:
            print(f"persistence error: {exc}", file=sys.stderr)
            self._error(500, "could not persist data")
            return
        self._json(200 if replaced else 201, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "bad_key":
            self._error(400, "invalid key")
            return
        if route != "key":
            self._error(404, "route not found")
            return
        try:
            deleted = self.server.store.delete(key or "")
        except OSError as exc:
            print(f"persistence error: {exc}", file=sys.stderr)
            self._error(500, "could not persist data")
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self.send_response(204)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _method_not_allowed(self) -> None:
        self._error(405, "method not allowed", {"Allow": "GET, PUT, DELETE"})

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
        server = KVServer((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"startup error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    exit_code = 0
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            store.flush()
        except OSError as exc:
            print(f"shutdown persistence error: {exc}", file=sys.stderr)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
