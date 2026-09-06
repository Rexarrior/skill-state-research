#!/usr/bin/env python3
"""A small, persistent HTTP key-value service."""

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


class Store:
    """Thread-safe store with synchronous, atomic persistence."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as stream:
            document = json.load(stream, parse_constant=self._reject_constant)
        if not isinstance(document, dict) or not isinstance(document.get("entries"), dict):
            raise ValueError("data file has an invalid format")

        loaded: dict[str, dict[str, Any]] = {}
        for key, entry in document["entries"].items():
            if not isinstance(key, str) or not isinstance(entry, dict):
                raise ValueError("data file has an invalid entry")
            if set(entry) != {"value", "expires_at"}:
                raise ValueError("data file has an invalid entry")
            expires_at = entry["expires_at"]
            if expires_at is not None and (
                isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or not math.isfinite(expires_at)
            ):
                raise ValueError("data file has an invalid expiry")
            loaded[key] = {"value": entry["value"], "expires_at": expires_at}

        self.entries = loaded
        if self._prune_locked():
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number: {value}")

    def _prune_locked(self) -> bool:
        now = time.time()
        expired = [
            key
            for key, entry in self.entries.items()
            if entry["expires_at"] is not None and entry["expires_at"] <= now
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(
                    {"entries": self.entries},
                    stream,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, self.path)
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Directory fsync is not available on every supported filesystem.
                pass
        except BaseException:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            old_entries = self.entries.copy()
            self._prune_locked()
            created = key not in self.entries
            expires_at = None if ttl is None else time.time() + ttl
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except BaseException:
                self.entries = old_entries
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            changed = self._prune_locked()
            if changed:
                self._persist_locked()
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            old_entries = self.entries.copy()
            self._prune_locked()
            if key not in self.entries:
                if self.entries != old_entries:
                    self._persist_locked()
                return False
            del self.entries[key]
            try:
                self._persist_locked()
            except BaseException:
                self.entries = old_entries
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._prune_locked():
                self._persist_locked()
            return sorted(self.entries)

    def compact(self) -> None:
        with self.lock:
            if self._prune_locked():
                self._persist_locked()


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] {fmt % args}",
            file=sys.stderr,
        )

    def _send_json(self, status: int, payload: Any) -> None:
        data = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _key(self) -> tuple[str | None, str | None]:
        path = self._path()
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None, None
        encoded = path[len(prefix) :]
        if not encoded:
            return None, "key must not be empty"
        # urllib deliberately leaves malformed percent escapes untouched.
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                if index + 2 >= len(encoded) or any(
                    char not in "0123456789abcdefABCDEF" for char in encoded[index + 1 : index + 3]
                ):
                    return None, "key has invalid percent encoding"
                index += 3
            else:
                index += 1
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
        if self.headers.get("Transfer-Encoding"):
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
            value = json.loads(body.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            return None, "malformed JSON", 400
        return value, None, 0

    def _store_error(self, operation: str, exc: BaseException) -> None:
        print(f"{operation} failed: {exc}", file=sys.stderr)
        self._error(500, "persistence failure")

    def do_GET(self) -> None:
        path = self._path()
        try:
            if path == "/health":
                self._send_json(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._send_json(200, {"keys": self.server.store.keys()})
                return
            key, error = self._key()
            if error is not None:
                self._error(400, error)
                return
            if key is not None:
                found, value = self.server.store.get(key)
                if found:
                    self._send_json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
                return
            self._error(404, "route not found")
        except (OSError, TypeError, ValueError) as exc:
            self._store_error("GET", exc)

    def do_PUT(self) -> None:
        key, key_error = self._key()
        if key_error is not None:
            self._error(400, key_error)
            return
        if key is None:
            self._error(404, "route not found")
            return
        document, body_error, status = self._read_json()
        if body_error is not None:
            self._error(status, body_error)
            return
        if not isinstance(document, dict):
            self._error(400, "body must be a JSON object")
            return
        if "value" not in document or not set(document).issubset({"value", "ttl_seconds"}):
            self._error(400, "body must contain value and optional ttl_seconds")
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
            created = self.server.store.put(key, document["value"], ttl)
            self._send_json(201 if created else 200, {"key": key, "value": document["value"]})
        except (OSError, TypeError, ValueError) as exc:
            self._store_error("PUT", exc)

    def do_DELETE(self) -> None:
        key, error = self._key()
        if error is not None:
            self._error(400, error)
            return
        if key is None:
            self._error(404, "route not found")
            return
        try:
            if self.server.store.delete(key):
                self._send_empty(204)
            else:
                self._error(404, "key not found")
        except (OSError, TypeError, ValueError) as exc:
            self._store_error("DELETE", exc)

    def _unsupported(self) -> None:
        path = self._path()
        key, key_error = self._key()
        if path in {"/health", "/v1/keys"} or key is not None or key_error is not None:
            self._error(405, "method not allowed")
        else:
            self._error(404, "route not found")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported
    do_HEAD = _unsupported
    do_CONNECT = _unsupported
    do_TRACE = _unsupported


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
        server = Server((args.host, args.port), store)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
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
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        try:
            store.compact()
        except OSError as exc:
            print(f"shutdown persistence failed: {exc}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
