#!/usr/bin/env python3
"""Persistent, dependency-free HTTP key-value service."""

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


MAX_BODY_SIZE = 1024 * 1024
KEY_PREFIX = "/v1/kv/"


class StoreError(RuntimeError):
    pass


class PersistentStore:
    """Thread-safe JSON-backed store.

    Entries are kept as ``key -> {value, expires_at}``, where expires_at is a
    Unix timestamp or None. Every logical mutation is durably persisted before
    the operation returns to its caller.
    """

    def __init__(self, path: str) -> None:
        self.path = Path(path).expanduser().resolve()
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_expired(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is not None and expires_at <= now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file: {exc}") from exc

        if not isinstance(raw, dict) or raw.get("version") != 1:
            raise StoreError("data file has an unsupported format")
        entries = raw.get("entries")
        if not isinstance(entries, dict):
            raise StoreError("data file has an invalid entries object")

        loaded: dict[str, dict[str, Any]] = {}
        for key, entry in entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise StoreError("data file contains an invalid key")
            if not isinstance(entry, dict) or "value" not in entry:
                raise StoreError("data file contains an invalid entry")
            expires_at = entry.get("expires_at")
            if expires_at is not None and (
                isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or not math.isfinite(expires_at)
            ):
                raise StoreError("data file contains an invalid expiration")
            loaded[key] = {"value": entry["value"], "expires_at": expires_at}

        self.entries = loaded
        if self._purge_expired_locked(time.time()):
            self._persist_locked()

    def _purge_expired_locked(self, now: float) -> bool:
        expired = [
            key for key, entry in self.entries.items() if self._is_expired(entry, now)
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
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
                os.replace(temporary_name, self.path)
                # Persist the directory entry where supported.
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
                    os.unlink(temporary_name)
                except OSError:
                    pass
                raise
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data: {exc}") from exc

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self.lock:
            now = time.time()
            old_entries = self.entries.copy()
            self._purge_expired_locked(now)
            created = key not in self.entries
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                self.entries = old_entries
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if self._is_expired(entry, time.time()):
                old_entry = self.entries.pop(key)
                try:
                    self._persist_locked()
                except StoreError:
                    self.entries[key] = old_entry
                    raise
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            now = time.time()
            old_entries = self.entries.copy()
            self._purge_expired_locked(now)
            if key not in self.entries:
                if self.entries != old_entries:
                    try:
                        self._persist_locked()
                    except StoreError:
                        self.entries = old_entries
                        raise
                return False
            del self.entries[key]
            try:
                self._persist_locked()
            except StoreError:
                self.entries = old_entries
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            old_entries = self.entries.copy()
            changed = self._purge_expired_locked(time.time())
            if changed:
                try:
                    self._persist_locked()
                except StoreError:
                    self.entries = old_entries
                    raise
            return sorted(self.entries)


def decode_key(path: str) -> tuple[str | None, str | None]:
    if not path.startswith(KEY_PREFIX):
        return None, "unknown route"
    encoded = path[len(KEY_PREFIX) :]
    if not encoded:
        return None, "key must not be empty"
    # A literal slash or an encoded slash would make the decoded key invalid.
    try:
        key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return None, "key must be valid UTF-8"
    if not key:
        return None, "key must not be empty"
    if "/" in key:
        return None, "key must not contain '/'"
    return key, None


class KVServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: PersistentStore) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - {fmt % args}", file=sys.stderr, flush=True
        )

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _no_content(self) -> None:
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _path(self) -> str | None:
        try:
            return urlsplit(self.path).path
        except ValueError:
            self._error(400, "invalid request target")
            return None

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
        if length > MAX_BODY_SIZE:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return False, None
        try:
            raw = self.rfile.read(length)
        except OSError:
            self._error(400, "could not read request body")
            return False, None
        try:
            return True, json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "malformed JSON")
            return False, None

    def do_GET(self) -> None:
        path = self._path()
        if path is None:
            return
        try:
            if path == "/health":
                self._json(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._json(200, {"keys": self.server.store.keys()})
                return
            if path.startswith(KEY_PREFIX):
                key, error = decode_key(path)
                if error:
                    self._error(400, error)
                    return
                found, value = self.server.store.get(key)  # type: ignore[arg-type]
                if not found:
                    self._error(404, "key not found")
                    return
                self._json(200, {"key": key, "value": value})
                return
            self._error(404, "unknown route")
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        path = self._path()
        if path is None:
            return
        if not path.startswith(KEY_PREFIX):
            self._error(404, "unknown route")
            return
        key, error = decode_key(path)
        if error:
            self._error(400, error)
            return
        ok, payload = self._read_json()
        if not ok:
            return
        if not isinstance(payload, dict) or "value" not in payload:
            self._error(400, "body must be an object containing 'value'")
            return
        if set(payload) - {"value", "ttl_seconds"}:
            self._error(400, "body contains unsupported fields")
            return
        ttl = payload.get("ttl_seconds")
        if "ttl_seconds" in payload and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.server.store.put(key, payload["value"], ttl)  # type: ignore[arg-type]
            self._json(201 if created else 200, {"key": key, "value": payload["value"]})
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_DELETE(self) -> None:
        path = self._path()
        if path is None:
            return
        if not path.startswith(KEY_PREFIX):
            self._error(404, "unknown route")
            return
        key, error = decode_key(path)
        if error:
            self._error(400, error)
            return
        try:
            if self.server.store.delete(key):  # type: ignore[arg-type]
                self._no_content()
            else:
                self._error(404, "key not found")
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

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
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = PersistentStore(args.data)
        server = KVServer((args.host, args.port), store)
    except (StoreError, OSError) as exc:
        print(f"fatal: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if stopping.is_set():
            return
        stopping.set()
        # shutdown() must be called from a different thread than serve_forever().
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    actual_port = server.server_address[1]
    print(f"LISTENING {actual_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
