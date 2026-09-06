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
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
_BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(Exception):
    """Raised when durable state cannot be loaded or saved."""


class PersistentStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entries: dict[str, dict[str, Any]], now: float) -> dict[str, dict[str, Any]]:
        return {
            key: entry
            for key, entry in entries.items()
            if entry["expires_at"] is None or entry["expires_at"] > now
        }

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
                raise ValueError("entries must be an object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid stored key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid stored entry")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid stored expiry")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load {self.path}: {exc}") from exc

        live = self._live(loaded, time.time())
        self._entries = live
        if len(live) != len(loaded):
            self._persist(live)

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON number {value}")

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as output:
                    json.dump(
                        {"version": 1, "entries": entries},
                        output,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                    )
                    output.write("\n")
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary_name, self.path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                except OSError:
                    directory_fd = None
                if directory_fd is not None:
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
            finally:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist {self.path}: {exc}") from exc

    def _pruned(self) -> tuple[dict[str, dict[str, Any]], bool]:
        live = self._live(self._entries, time.time())
        return live, len(live) != len(self._entries)

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self._lock:
            entries, _ = self._pruned()
            created = key not in entries
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            entries[key] = {"value": value, "expires_at": expires_at}
            self._persist(entries)
            self._entries = entries
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            entries, changed = self._pruned()
            if changed:
                self._persist(entries)
                self._entries = entries
            entry = entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self._lock:
            entries, pruned = self._pruned()
            present = key in entries
            if present:
                del entries[key]
            if present or pruned:
                self._persist(entries)
                self._entries = entries
            return present

    def keys(self) -> list[str]:
        with self._lock:
            entries, changed = self._pruned()
            if changed:
                self._persist(entries)
                self._entries = entries
            return sorted(entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: PersistentStore) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"{self.address_string()} - {format % args}\n")

    def _send_json(self, status: int, payload: Any | None) -> None:
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

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        if code == HTTPStatus.NOT_IMPLEMENTED:
            self._unsupported_method()
        else:
            self._error(code, message or HTTPStatus(code).phrase)

    def _route(self) -> tuple[str, str | None, str | None]:
        path = urlsplit(self.path).path
        if path == "/health":
            return "health", None, None
        if path == "/v1/keys":
            return "keys", None, None
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return "unknown", None, None
        encoded = path[len(prefix):]
        if not encoded:
            return "invalid", None, "key must not be empty"
        if "/" in encoded:
            return "invalid", None, "key must not contain '/'"
        if _BAD_ESCAPE.search(encoded):
            return "invalid", None, "key has invalid percent encoding"
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return "invalid", None, "key must be valid UTF-8"
        if not key:
            return "invalid", None, "key must not be empty"
        if "/" in key:
            return "invalid", None, "key must not contain '/'"
        return "kv", key, None

    def _checked_route(self) -> tuple[str, str | None] | None:
        route, key, error = self._route()
        if route == "invalid":
            self._error(HTTPStatus.BAD_REQUEST, error or "invalid key")
            return None
        if route == "unknown":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
            return None
        return route, key

    def _body_length(self) -> int | None:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
            return None
        header = self.headers.get("Content-Length")
        if header is None:
            self._error(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            return None
        try:
            length = int(header, 10)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length < 0:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            return None
        return length

    def handle_expect_100(self) -> bool:
        header = self.headers.get("Content-Length")
        try:
            length = int(header, 10) if header is not None else -1
        except ValueError:
            length = -1
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            return False
        return super().handle_expect_100()

    def _read_json(self) -> Any | None:
        length = self._body_length()
        if length is None:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"), parse_constant=PersistentStore._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return None

    def do_GET(self) -> None:
        checked = self._checked_route()
        if checked is None:
            return
        route, key = checked
        try:
            if route == "health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
            elif route == "keys":
                self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            elif route == "kv":
                found, value = self.server.store.get(key or "")
                if found:
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            else:
                self._unsupported_method()
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def do_PUT(self) -> None:
        checked = self._checked_route()
        if checked is None:
            return
        route, key = checked
        if route != "kv":
            self._unsupported_method()
            return
        document = self._read_json()
        if document is None:
            return
        if not isinstance(document, dict) or "value" not in document or not set(document) <= {"value", "ttl_seconds"}:
            self._error(HTTPStatus.BAD_REQUEST, "body must contain value and optional ttl_seconds")
            return
        ttl = document.get("ttl_seconds")
        if "ttl_seconds" in document and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.server.store.put(key or "", document["value"], ttl)
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")
            return
        self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        checked = self._checked_route()
        if checked is None:
            return
        route, key = checked
        if route != "kv":
            self._unsupported_method()
            return
        try:
            deleted = self.server.store.delete(key or "")
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")
            return
        if deleted:
            self._send_json(HTTPStatus.NO_CONTENT, None)
        else:
            self._error(HTTPStatus.NOT_FOUND, "key not found")

    def _unsupported_method(self) -> None:
        route, _, error = self._route()
        if route == "invalid":
            self._error(HTTPStatus.BAD_REQUEST, error or "invalid key")
        elif route == "unknown":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
        else:
            allowed = {"health": "GET", "keys": "GET", "kv": "GET, PUT, DELETE"}[route]
            body = json.dumps({"error": "method not allowed"}, separators=(",", ":")).encode("utf-8")
            self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
            self.send_header("Allow", allowed)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

    do_POST = _unsupported_method
    do_PATCH = _unsupported_method
    do_HEAD = _unsupported_method
    do_OPTIONS = _unsupported_method
    do_CONNECT = _unsupported_method
    do_TRACE = _unsupported_method


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
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
        store = PersistentStore(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup error: {exc}", file=sys.stderr)
        return 1

    shutting_down = threading.Event()

    def stop(signum: int, frame: Any) -> None:
        del signum, frame
        if not shutting_down.is_set():
            shutting_down.set()
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
