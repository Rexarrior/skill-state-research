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
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")
BODY_ERROR = object()


class StoreError(Exception):
    """Raised when the durable state cannot be read or written."""


@dataclass(frozen=True)
class Entry:
    value: Any
    expires_at: int | float | None

    def live_at(self, now: float) -> bool:
        return self.expires_at is None or self.expires_at > now


class PersistentStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.RLock()
        self._entries = self._load()
        with self._lock:
            if self._remove_expired_locked(time.time()):
                self._persist_locked(self._entries)

    def _load(self) -> dict[str, Entry]:
        if not self._path.exists():
            return {}
        try:
            if self._path.stat().st_size == 0:
                return {}
            with self._path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise StoreError(f"cannot read data file {self._path}: {exc}") from exc

        if not isinstance(document, dict) or document.get("version") != 1:
            raise StoreError(f"invalid data file format in {self._path}")
        raw_entries = document.get("entries")
        if not isinstance(raw_entries, dict):
            raise StoreError(f"invalid entries in data file {self._path}")

        entries: dict[str, Entry] = {}
        for key, raw_entry in raw_entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise StoreError(f"invalid key in data file {self._path}")
            if not isinstance(raw_entry, dict) or set(raw_entry) != {
                "value",
                "expires_at",
            }:
                raise StoreError(f"invalid entry for key {key!r} in data file")
            expires_at = raw_entry["expires_at"]
            if expires_at is not None and not finite_number(expires_at):
                raise StoreError(f"invalid expiration for key {key!r} in data file")
            entries[key] = Entry(raw_entry["value"], expires_at)
        return entries

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number {value}")

    def _remove_expired_locked(self, now: float) -> bool:
        expired = [key for key, entry in self._entries.items() if not entry.live_at(now)]
        for key in expired:
            del self._entries[key]
        return bool(expired)

    def _persist_locked(self, entries: dict[str, Entry]) -> None:
        parent = self._path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            document = {
                "version": 1,
                "entries": {
                    key: {
                        "value": entry.value,
                        "expires_at": entry.expires_at,
                    }
                    for key, entry in entries.items()
                },
            }
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self._path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as destination:
                    json.dump(
                        document,
                        destination,
                        ensure_ascii=True,
                        allow_nan=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                    destination.write("\n")
                    destination.flush()
                    os.fsync(destination.fileno())
                os.replace(temporary_name, self._path)
                self._fsync_directory(parent)
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data file {self._path}: {exc}") from exc

    @staticmethod
    def _fsync_directory(directory: Path) -> None:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        try:
            descriptor = os.open(directory, flags)
        except OSError:
            return
        try:
            os.fsync(descriptor)
        except OSError:
            pass
        finally:
            os.close(descriptor)

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        """Persist a value and return True when it replaced a live value."""
        with self._lock:
            now = time.time()
            live_entries = {
                item_key: entry
                for item_key, entry in self._entries.items()
                if entry.live_at(now)
            }
            replaced = key in live_entries
            if ttl_seconds is None:
                expires_at = None
            else:
                try:
                    expires_at = now + ttl_seconds
                except OverflowError:
                    # JSON integers are arbitrary precision and therefore finite
                    # even when they cannot be represented as a Python float.
                    expires_at = math.ceil(now) + ttl_seconds
            live_entries[key] = Entry(value, expires_at)
            self._persist_locked(live_entries)
            self._entries = live_entries
            return replaced

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            if not entry.live_at(time.time()):
                updated = dict(self._entries)
                del updated[key]
                self._persist_locked(updated)
                self._entries = updated
                return False, None
            return True, entry.value

    def delete(self, key: str) -> bool:
        with self._lock:
            now = time.time()
            live_entries = {
                item_key: entry
                for item_key, entry in self._entries.items()
                if entry.live_at(now)
            }
            present = key in live_entries
            if present:
                del live_entries[key]
            if present or len(live_entries) != len(self._entries):
                self._persist_locked(live_entries)
                self._entries = live_entries
            return present

    def keys(self) -> list[str]:
        with self._lock:
            now = time.time()
            live_entries = {
                key: entry for key, entry in self._entries.items() if entry.live_at(now)
            }
            if len(live_entries) != len(self._entries):
                self._persist_locked(live_entries)
                self._entries = live_entries
            return sorted(live_entries)


class KVHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = False
    block_on_close = True

    def __init__(self, address: tuple[str, int], store: PersistentStore) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVHTTPServer
    protocol_version = "HTTP/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - {format_string % args}",
            file=sys.stderr,
            flush=True,
        )

    def __getattr__(self, name: str) -> Any:
        # BaseHTTPRequestHandler otherwise emits an HTML 501 response for a
        # syntactically valid but unknown method token.
        if name.startswith("do_"):
            return self._method_not_allowed
        raise AttributeError(name)

    def send_error(
        self, code: int, message: str | None = None, explain: str | None = None
    ) -> None:
        """Keep errors generated by the HTTP parser JSON as well."""
        del explain
        self._error(code, message or self.responses.get(code, ("error",))[0])

    def _send_json(self, status: int, document: Any) -> None:
        body = json.dumps(
            document, ensure_ascii=True, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_empty_json(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _route_path(self) -> str | None:
        try:
            split = urlsplit(self.path)
        except ValueError:
            self._error(400, "invalid request target")
            return None
        if split.query or split.fragment:
            self._error(404, "route not found")
            return None
        return split.path

    def _key_from_path(self, path: str) -> str | None:
        if not path.startswith(KEY_PREFIX):
            return None
        encoded = path[len(KEY_PREFIX) :]
        if PERCENT_ESCAPE.search(encoded):
            self._error(400, "invalid percent-encoding in key")
            return ""
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            self._error(400, "key must be valid UTF-8")
            return ""
        if not key or "/" in key:
            self._error(400, "key must be non-empty and must not contain '/'")
            return ""
        return key

    def _read_json_body(self) -> Any:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._error(415, "Content-Type must be application/json")
            return BODY_ERROR
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._error(400, "transfer encoding is not supported")
            return BODY_ERROR
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "Content-Length is required")
            return BODY_ERROR
        try:
            length = int(raw_length, 10)
        except ValueError:
            self._error(400, "invalid Content-Length")
            return BODY_ERROR
        if length < 0:
            self._error(400, "invalid Content-Length")
            return BODY_ERROR
        if length > MAX_BODY_BYTES:
            # Drain the request a chunk at a time so clients that transmit the body
            # eagerly can still receive the 413 response instead of a TCP reset.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return BODY_ERROR
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            self._error(400, "incomplete request body")
            return BODY_ERROR
        try:
            return json.loads(body, parse_constant=PersistentStore._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(400, "malformed JSON")
            return BODY_ERROR

    def do_GET(self) -> None:
        path = self._route_path()
        if path is None:
            return
        if path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            try:
                keys = self.server.store.keys()
            except StoreError as exc:
                self.log_error("storage error: %s", exc)
                self._error(500, "storage operation failed")
                return
            self._send_json(200, {"keys": keys})
            return
        key = self._key_from_path(path)
        if key is None:
            self._error(404, "route not found")
            return
        if key == "":
            return
        try:
            present, value = self.server.store.get(key)
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage operation failed")
            return
        if not present:
            self._error(404, "key not found")
            return
        self._send_json(200, {"key": key, "value": value})

    def do_PUT(self) -> None:
        path = self._route_path()
        if path is None:
            return
        key = self._key_from_path(path)
        if key is None:
            self._error(404, "route not found")
            return
        if key == "":
            return
        document = self._read_json_body()
        if document is BODY_ERROR:
            return
        if not isinstance(document, dict) or "value" not in document:
            self._error(400, "body must be an object containing 'value'")
            return
        if not set(document).issubset({"value", "ttl_seconds"}):
            self._error(400, "body contains unsupported fields")
            return
        ttl = document.get("ttl_seconds")
        if "ttl_seconds" in document and (
            not finite_number(ttl) or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            replaced = self.server.store.put(key, document["value"], ttl)
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage operation failed")
            return
        self._send_json(200 if replaced else 201, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        path = self._route_path()
        if path is None:
            return
        key = self._key_from_path(path)
        if key is None:
            self._error(404, "route not found")
            return
        if key == "":
            return
        try:
            deleted = self.server.store.delete(key)
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage operation failed")
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self._send_empty_json(204)

    def _method_not_allowed(self) -> None:
        body = json.dumps({"error": "method not allowed"}, separators=(",", ":")).encode()
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_CONNECT = _method_not_allowed
    do_TRACE = _method_not_allowed


def finite_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    return False


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", required=True, help="address on which to listen")
    parser.add_argument("--port", required=True, type=int, help="port (0 selects a free port)")
    parser.add_argument("--data", required=True, type=Path, help="JSON persistence file")
    arguments = parser.parse_args()
    if not 0 <= arguments.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return arguments


def main() -> int:
    arguments = parse_arguments()
    try:
        store = PersistentStore(arguments.data)
        server = KVHTTPServer((arguments.host, arguments.port), store)
    except (StoreError, OSError) as exc:
        print(f"startup error: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def request_shutdown(signum: int, frame: Any) -> None:
        del signum, frame
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
