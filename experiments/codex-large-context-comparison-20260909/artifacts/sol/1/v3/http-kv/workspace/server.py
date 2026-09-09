#!/usr/bin/env python3
"""Persistent, dependency-free HTTP key-value service."""

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
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
_BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(RuntimeError):
    """Raised when durable state cannot be loaded or saved."""


@dataclass(frozen=True)
class Entry:
    value: Any
    expires_at: float | None

    def is_live(self, now: float) -> bool:
        return self.expires_at is None or self.expires_at > now


class PersistentStore:
    """A lock-protected key-value store persisted with atomic replacement."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, Entry] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("invalid top-level structure")

            now = time.time()
            loaded: dict[str, Entry] = {}
            for key, raw_entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(raw_entry, dict):
                    raise ValueError("invalid entry structure")
                if set(raw_entry) != {"value", "expires_at"}:
                    raise ValueError("invalid entry fields")
                expires_at = raw_entry["expires_at"]
                if expires_at is not None:
                    if (
                        isinstance(expires_at, bool)
                        or not isinstance(expires_at, (int, float))
                        or not math.isfinite(expires_at)
                    ):
                        raise ValueError("invalid expiration time")
                    expires_at = float(expires_at)
                entry = Entry(raw_entry["value"], expires_at)
                if entry.is_live(now):
                    loaded[key] = entry
            self._entries = loaded
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"could not load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(token: str) -> None:
        raise ValueError(f"non-finite JSON number: {token}")

    @staticmethod
    def _live(entries: dict[str, Entry], now: float) -> dict[str, Entry]:
        return {key: entry for key, entry in entries.items() if entry.is_live(now)}

    def _persist(self, entries: dict[str, Entry]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            document = {
                "entries": {
                    key: {"value": entry.value, "expires_at": entry.expires_at}
                    for key, entry in entries.items()
                }
            }
            encoded = json.dumps(
                document,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            )
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as destination:
                    destination.write(encoded)
                    destination.write("\n")
                    destination.flush()
                    os.fsync(destination.fileno())
                os.replace(temporary_name, self.path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    # Directory fsync is unavailable on some platforms. The file
                    # replacement itself is still atomic.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass
                raise
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"could not persist data file {self.path}: {exc}") from exc

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self._lock:
            now = time.time()
            live = self._live(self._entries, now)
            created = key not in live
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            if expires_at is not None and not math.isfinite(expires_at):
                raise ValueError("ttl_seconds is too large")
            updated = dict(live)
            updated[key] = Entry(value, expires_at)
            self._persist(updated)
            self._entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or not entry.is_live(time.time()):
                if entry is not None:
                    self._entries.pop(key, None)
                return False, None
            return True, entry.value

    def delete(self, key: str) -> bool:
        with self._lock:
            live = self._live(self._entries, time.time())
            if key not in live:
                self._entries = live
                return False
            updated = dict(live)
            del updated[key]
            self._persist(updated)
            self._entries = updated
            return True

    def keys(self) -> list[str]:
        with self._lock:
            live = self._live(self._entries, time.time())
            self._entries = live
            return sorted(live)

    def flush(self) -> None:
        with self._lock:
            live = self._live(self._entries, time.time())
            self._persist(live)
            self._entries = live


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: PersistentStore):
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] " + format % args,
            file=sys.stderr,
        )

    def _send_json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _path(self) -> str | None:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self._error(400, "invalid request target")
            return None
        return parsed.path

    def _key(self, path: str) -> str | None:
        prefix = "/v1/kv/"
        encoded_key = path[len(prefix) :]
        if not encoded_key or "/" in encoded_key or _BAD_PERCENT_ESCAPE.search(encoded_key):
            self._error(400, "invalid key")
            return None
        try:
            key = unquote_to_bytes(encoded_key).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            self._error(400, "key must be valid UTF-8")
            return None
        if not key or "/" in key:
            self._error(400, "invalid key")
            return None
        return key

    def _read_document(self) -> Any | None:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._error(400, "transfer encoding is not supported")
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "Content-Length is required")
            return None
        try:
            length = int(raw_length, 10)
        except ValueError:
            self._error(400, "invalid Content-Length")
            return None
        if length < 0:
            self._error(400, "invalid Content-Length")
            return None
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return None
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            self._error(400, "incomplete request body")
            return None
        try:
            return json.loads(body, parse_constant=PersistentStore._reject_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._error(400, "malformed JSON")
            return None

    def do_GET(self) -> None:
        path = self._path()
        if path is None:
            return
        if path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            self._send_json(200, {"keys": self.server.store.keys()})
            return
        if path.startswith("/v1/kv/"):
            key = self._key(path)
            if key is None:
                return
            found, value = self.server.store.get(key)
            if not found:
                self._error(404, "key not found")
            else:
                self._send_json(200, {"key": key, "value": value})
            return
        self._error(404, "route not found")

    def do_PUT(self) -> None:
        path = self._path()
        if path is None:
            return
        if not path.startswith("/v1/kv/"):
            self._error(404, "route not found")
            return
        key = self._key(path)
        if key is None:
            return
        document = self._read_document()
        if document is None:
            return
        if not isinstance(document, dict) or "value" not in document:
            self._error(400, "body must be an object containing value")
            return
        if set(document) - {"value", "ttl_seconds"}:
            self._error(400, "body contains unknown fields")
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None:
            if (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                self._error(400, "ttl_seconds must be finite and greater than zero")
                return
            ttl = float(ttl)
        try:
            created = self.server.store.put(key, document["value"], ttl)
        except ValueError as exc:
            self._error(400, str(exc))
            return
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "could not persist data")
            return
        self._send_json(201 if created else 200, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        path = self._path()
        if path is None:
            return
        if not path.startswith("/v1/kv/"):
            self._error(404, "route not found")
            return
        key = self._key(path)
        if key is None:
            return
        try:
            deleted = self.server.store.delete(key)
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "could not persist data")
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="address to bind")
    parser.add_argument("--port", required=True, type=int, help="port to bind (0 for any)")
    parser.add_argument("--data", required=True, type=Path, help="JSON data file")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = PersistentStore(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def request_stop(signum: int, frame: Any) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    server.timeout = 0.25
    print(f"LISTENING {server.server_address[1]}", flush=True)

    exit_code = 0
    try:
        while not stopping.is_set():
            server.handle_request()
    except KeyboardInterrupt:
        stopping.set()
    finally:
        server.server_close()
        try:
            store.flush()
        except StoreError as exc:
            print(f"error: {exc}", file=sys.stderr)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
