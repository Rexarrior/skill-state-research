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
API_PREFIX = "/v1/kv/"


class StoreError(Exception):
    """Raised when durable storage cannot be read or written."""


class Store:
    def __init__(self, filename: Path) -> None:
        self.filename = filename
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.filename.exists():
            return
        try:
            with self.filename.open("r", encoding="utf-8") as stream:
                document = json.load(stream, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data file format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("entries must be an object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid key in data file")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid entry in data file")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiration in data file")
                # Validate now so an unencodable value cannot poison future writes.
                json.dumps(entry["value"], allow_nan=False)
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.filename}: {exc}") from exc

        now = time.time()
        self._entries = {
            key: entry
            for key, entry in loaded.items()
            if entry["expires_at"] is None or entry["expires_at"] > now
        }
        if len(self._entries) != len(loaded):
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON number {value}")

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [
            key
            for key, entry in self._entries.items()
            if entry["expires_at"] is not None and entry["expires_at"] <= now
        ]
        for key in expired:
            del self._entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.filename.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            payload = {"version": 1, "entries": self._entries}
            fd, temporary = tempfile.mkstemp(
                dir=str(parent), prefix=f".{self.filename.name}.", suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(
                        payload,
                        stream,
                        ensure_ascii=False,
                        separators=(",", ":"),
                        allow_nan=False,
                    )
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.filename)
                # Make the rename durable where directory fsync is supported.
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
                except OSError:
                    pass
                raise
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.filename}: {exc}") from exc

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self._lock:
            self._purge_locked()
            created = key not in self._entries
            previous = self._entries.get(key)
            expires_at = None if ttl is None else time.time() + ttl
            self._entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                if previous is None:
                    del self._entries[key]
                else:
                    self._entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            if self._purge_locked():
                self._persist_locked()
            entry = self._entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self._lock:
            purged = self._purge_locked()
            if key not in self._entries:
                if purged:
                    self._persist_locked()
                return False
            previous = self._entries.pop(key)
            try:
                self._persist_locked()
            except StoreError:
                self._entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            if self._purge_locked():
                self._persist_locked()
            return sorted(self._entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] "
            + (format_string % args),
            file=sys.stderr,
        )

    def _send_json(self, status: int, value: Any, headers: dict[str, str] | None = None) -> None:
        encoded = json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        if headers:
            for name, header_value in headers.items():
                self.send_header(name, header_value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str, headers: dict[str, str] | None = None) -> None:
        self._send_json(status, {"error": message}, headers)

    def _route(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        if parsed.path.startswith(API_PREFIX):
            encoded_key = parsed.path[len(API_PREFIX) :]
            try:
                if any(
                    encoded_key[index] == "%"
                    and (
                        index + 2 >= len(encoded_key)
                        or any(char not in "0123456789abcdefABCDEF" for char in encoded_key[index + 1 : index + 3])
                    )
                    for index in range(len(encoded_key))
                ):
                    raise ValueError
                key = unquote_to_bytes(encoded_key).decode("utf-8", errors="strict")
            except (UnicodeDecodeError, ValueError):
                return "invalid_key", None
            if not key or "/" in key:
                return "invalid_key", None
            return "kv", key
        return "unknown", None

    def _read_json_object(self) -> dict[str, Any] | None:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            self._error(400, "chunked request bodies are not supported")
            self.close_connection = True
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "Content-Length is required")
            return None
        try:
            length = int(raw_length, 10)
            if length < 0:
                raise ValueError
        except ValueError:
            self._error(400, "invalid Content-Length")
            self.close_connection = True
            return None
        if length > MAX_BODY:
            self._error(413, "request body exceeds 1 MiB limit")
            self.close_connection = True
            return None
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("incomplete request body")
            document = json.loads(
                raw.decode("utf-8"), parse_constant=Store._reject_constant
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._error(400, "malformed JSON")
            return None
        if not isinstance(document, dict):
            self._error(400, "request body must be a JSON object")
            return None
        return document

    def do_GET(self) -> None:
        route, key = self._route()
        try:
            if route == "health":
                self._send_json(200, {"status": "ok"})
            elif route == "keys":
                self._send_json(200, {"keys": self.server.store.keys()})
            elif route == "kv":
                assert key is not None
                found, value = self.server.store.get(key)
                if found:
                    self._send_json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            elif route == "invalid_key":
                self._error(400, "invalid key")
            else:
                self._error(404, "route not found")
        except StoreError as exc:
            print(exc, file=sys.stderr)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._error(400, "invalid key")
            return
        if route != "kv":
            self._error(404, "route not found")
            return
        document = self._read_json_object()
        if document is None:
            return
        if "value" not in document or not set(document).issubset({"value", "ttl_seconds"}):
            self._error(400, "body must contain value and optional ttl_seconds")
            return
        ttl: float | None = None
        if "ttl_seconds" in document:
            raw_ttl = document["ttl_seconds"]
            if isinstance(raw_ttl, bool) or not isinstance(raw_ttl, (int, float)):
                self._error(400, "ttl_seconds must be a finite number greater than zero")
                return
            try:
                ttl = float(raw_ttl)
            except (OverflowError, ValueError):
                ttl = math.nan
            if not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
                self._error(400, "ttl_seconds must be a finite number greater than zero")
                return
        try:
            # It was parsed as JSON, but this also documents/polices persistence safety.
            json.dumps(document["value"], allow_nan=False)
            assert key is not None
            created = self.server.store.put(key, document["value"], ttl)
            self._send_json(201 if created else 200, {"key": key, "value": document["value"]})
        except (ValueError, TypeError):
            self._error(400, "value is not valid JSON")
        except StoreError as exc:
            print(exc, file=sys.stderr)
            self._error(500, "storage error")

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._error(400, "invalid key")
            return
        if route != "kv":
            self._error(404, "route not found")
            return
        try:
            assert key is not None
            if self.server.store.delete(key):
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self._error(404, "key not found")
        except StoreError as exc:
            print(exc, file=sys.stderr)
            self._error(500, "storage error")

    def _unsupported(self) -> None:
        self._error(405, "method not allowed", {"Allow": "GET, PUT, DELETE"})

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


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
    except (OSError, StoreError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr)
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
