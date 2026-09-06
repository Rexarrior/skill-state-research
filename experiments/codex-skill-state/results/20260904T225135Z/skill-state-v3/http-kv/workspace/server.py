#!/usr/bin/env python3
"""A small persistent HTTP JSON key-value service."""

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
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


class PersistentStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
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
                document = json.load(source, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("data-file entries must be an object")

            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            removed_expired = False
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("data file contains an invalid key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("data file contains an invalid entry")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("data file contains an invalid expiration")
                if self._is_live(entry, now):
                    loaded[key] = entry
                else:
                    removed_expired = True
            self._entries = loaded
            if removed_expired:
                self._persist(loaded)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc


    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number: {value}")

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                dir=parent, prefix=f".{self.path.name}.", suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as target:
                    json.dump(
                        {"version": 1, "entries": entries},
                        target,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                    )
                    target.write("\n")
                    target.flush()
                    os.fsync(target.fileno())
                os.replace(temporary_name, self.path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    # Some platforms/filesystems do not support fsync on directories.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    def _live_copy(self, now: float) -> tuple[dict[str, dict[str, Any]], bool]:
        live = {
            key: entry
            for key, entry in self._entries.items()
            if self._is_live(entry, now)
        }
        return live, len(live) != len(self._entries)

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            live, changed = self._live_copy(time.time())
            if changed:
                self._persist(live)
                self._entries = live
            entry = self._entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self._lock:
            now = time.time()
            live, _ = self._live_copy(now)
            created = key not in live
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            candidate = dict(live)
            candidate[key] = {"value": value, "expires_at": expires_at}
            self._persist(candidate)
            self._entries = candidate
            return created

    def delete(self, key: str) -> bool:
        with self._lock:
            live, expired_removed = self._live_copy(time.time())
            present = key in live
            if present:
                del live[key]
            if present or expired_removed:
                self._persist(live)
                self._entries = live
            return present

    def keys(self) -> list[str]:
        with self._lock:
            live, changed = self._live_copy(time.time())
            if changed:
                self._persist(live)
                self._entries = live
            return sorted(self._entries)

    def compact(self) -> None:
        with self._lock:
            live, changed = self._live_copy(time.time())
            if changed:
                self._persist(live)
                self._entries = live


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: PersistentStore) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"

    @property
    def kv_server(self) -> KVServer:
        return self.server  # type: ignore[return-value]

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] {format % args}",
            file=sys.stderr,
            flush=True,
        )

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        # BaseHTTPRequestHandler uses 501 for methods without a do_* handler.
        if code == HTTPStatus.NOT_IMPLEMENTED:
            code = HTTPStatus.METHOD_NOT_ALLOWED
        self._send_json(code, {"error": message or HTTPStatus(code).phrase})

    def _send_json(self, status: int, document: Any | None = None) -> None:
        body = b""
        if document is not None:
            body = json.dumps(
                document,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        self.send_response(status)
        if document is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _route(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if not parsed.path.startswith(prefix):
            return "unknown", None
        encoded = parsed.path[len(prefix) :]
        if not encoded or "/" in encoded:
            return "bad_key", None
        try:
            index = 0
            while index < len(encoded):
                if encoded[index] == "%":
                    if index + 2 >= len(encoded) or any(
                        char not in "0123456789abcdefABCDEF"
                        for char in encoded[index + 1 : index + 3]
                    ):
                        raise ValueError
                    index += 3
                else:
                    index += 1
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError):
            return "bad_key", None
        if not key or "/" in key:
            return "bad_key", None
        return "item", key

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding"):
            raise HTTPInputError(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise HTTPInputError(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
        try:
            length = int(raw_length, 10)
        except ValueError as exc:
            raise HTTPInputError(HTTPStatus.BAD_REQUEST, "invalid Content-Length") from exc
        if length < 0:
            raise HTTPInputError(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            # Consume the request incrementally before replying.  Closing while a
            # client is still transmitting a slightly oversized body can make it
            # observe BrokenPipe instead of the intended HTTP 413 response.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            raise HTTPInputError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        if len(body) != length:
            raise HTTPInputError(HTTPStatus.BAD_REQUEST, "incomplete request body")
        try:
            return json.loads(body, parse_constant=PersistentStore._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise HTTPInputError(HTTPStatus.BAD_REQUEST, "malformed JSON") from exc

    def _method_not_allowed(self, allowed: tuple[str, ...]) -> None:
        body = json.dumps({"error": "method not allowed"}, separators=(",", ":")).encode()
        self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
        self.send_header("Allow", ", ".join(allowed))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _dispatch(self) -> None:
        route, key = self._route()
        if route == "unknown":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
            return
        if route == "bad_key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            return

        allowed = {
            "health": ("GET",),
            "keys": ("GET",),
            "item": ("GET", "PUT", "DELETE"),
        }[route]
        if self.command not in allowed:
            self._method_not_allowed(allowed)
            return

        try:
            if route == "health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
            elif route == "keys":
                self._send_json(HTTPStatus.OK, {"keys": self.kv_server.store.keys()})
            elif self.command == "GET":
                found, value = self.kv_server.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            elif self.command == "DELETE":
                if self.kv_server.store.delete(key):  # type: ignore[arg-type]
                    self._send_json(HTTPStatus.NO_CONTENT)
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            else:
                document = self._read_json()
                if not isinstance(document, dict):
                    raise HTTPInputError(HTTPStatus.BAD_REQUEST, "JSON body must be an object")
                if "value" not in document or not set(document) <= {"value", "ttl_seconds"}:
                    raise HTTPInputError(HTTPStatus.BAD_REQUEST, "invalid JSON body shape")
                ttl = document.get("ttl_seconds")
                if ttl is not None and (
                    isinstance(ttl, bool)
                    or not isinstance(ttl, (int, float))
                    or not math.isfinite(ttl)
                    or ttl <= 0
                ):
                    raise HTTPInputError(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
                created = self.kv_server.store.put(key, document["value"], ttl)  # type: ignore[arg-type]
                self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": document["value"]})
        except HTTPInputError as exc:
            self._error(exc.status, exc.message)
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    do_GET = _dispatch
    do_PUT = _dispatch
    do_DELETE = _dispatch
    do_POST = _dispatch
    do_PATCH = _dispatch
    do_OPTIONS = _dispatch
    do_HEAD = _dispatch


class HTTPInputError(Exception):
    def __init__(self, status: int, message: str) -> None:
        self.status = status
        self.message = message
        super().__init__(message)


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
        store = PersistentStore(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup error: {exc}", file=sys.stderr, flush=True)
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
    exit_status = 0
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        try:
            store.compact()
        except StoreError as exc:
            print(f"shutdown error: {exc}", file=sys.stderr, flush=True)
            exit_status = 1
    return exit_status


if __name__ == "__main__":
    raise SystemExit(main())
