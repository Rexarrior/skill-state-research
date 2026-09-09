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


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


class Store:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entry: dict[str, Any], now: float) -> bool:
        expiry = entry["expires_at"]
        return expiry is None or expiry > now

    def _purged(self, now: float) -> tuple[dict[str, dict[str, Any]], bool]:
        entries = {
            key: entry
            for key, entry in self._entries.items()
            if self._live(entry, now)
        }
        return entries, len(entries) != len(self._entries)

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                document = json.load(stream, parse_constant=self._reject_constant)
            raw_entries = document["entries"]
            if document.get("version") != 1 or not isinstance(raw_entries, dict):
                raise ValueError("unsupported persistence format")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid persisted key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid persisted entry")
                expiry = entry["expires_at"]
                if expiry is not None and (
                    isinstance(expiry, bool)
                    or not isinstance(expiry, (int, float))
                    or not math.isfinite(expiry)
                ):
                    raise ValueError("invalid persisted expiry")
                loaded[key] = {"value": entry["value"], "expires_at": expiry}
            self._entries = loaded
            live, changed = self._purged(time.time())
            if changed:
                self._persist(live)
                self._entries = live
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(
                        {"version": 1, "entries": entries},
                        stream,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                    )
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    # Some filesystems do not permit syncing a directory.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
                raise
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist {self.path}: {exc}") from exc

    def _remove_expired(self, now: float) -> None:
        live, changed = self._purged(now)
        if changed:
            self._persist(live)
            self._entries = live

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self._lock:
            now = time.time()
            live, _ = self._purged(now)
            created = key not in live
            updated = dict(live)
            updated[key] = {
                "value": value,
                "expires_at": None if ttl is None else now + ttl,
            }
            self._persist(updated)
            self._entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            self._remove_expired(time.time())
            if key not in self._entries:
                return False, None
            return True, self._entries[key]["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            now = time.time()
            live, _ = self._purged(now)
            if key not in live:
                if live != self._entries:
                    self._persist(live)
                    self._entries = live
                return False
            updated = dict(live)
            del updated[key]
            self._persist(updated)
            self._entries = updated
            return True

    def keys(self) -> list[str]:
        with self._lock:
            self._remove_expired(time.time())
            return sorted(self._entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(
            "%s - - [%s] %s\n"
            % (self.address_string(), self.log_date_time_string(), format % args)
        )

    def _send_json(self, status: int, document: Any) -> None:
        payload = json.dumps(
            document, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _path(self) -> str | None:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid request target")
            return None
        if parsed.query or parsed.fragment:
            self._error(HTTPStatus.NOT_FOUND, "unknown route")
            return None
        return parsed.path

    def _key(self, path: str) -> str | None:
        encoded = path[len(KEY_PREFIX) :]
        if not encoded or "/" in encoded:
            self._error(HTTPStatus.BAD_REQUEST, "key must be non-empty and contain no slash")
            return None
        if BAD_ESCAPE.search(encoded):
            self._error(HTTPStatus.BAD_REQUEST, "invalid URL encoding")
            return None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            self._error(HTTPStatus.BAD_REQUEST, "key must be valid UTF-8")
            return None
        if not key or "/" in key:
            self._error(HTTPStatus.BAD_REQUEST, "key must be non-empty and contain no slash")
            return None
        return key

    def _route(self) -> tuple[str, str | None] | None:
        path = self._path()
        if path is None:
            return None
        if path == "/health":
            return "health", None
        if path == "/v1/keys":
            return "keys", None
        if path.startswith(KEY_PREFIX):
            key = self._key(path)
            return None if key is None else ("key", key)
        self._error(HTTPStatus.NOT_FOUND, "unknown route")
        return None

    def _content_length(self) -> int | None:
        values = self.headers.get_all("Content-Length", [])
        if len(values) != 1:
            self._error(HTTPStatus.BAD_REQUEST, "exactly one Content-Length is required")
            return None
        try:
            length = int(values[0], 10)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length < 0:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length > MAX_BODY:
            self.close_connection = True
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            return None
        return length

    def _read_document(self) -> Any | None:
        length = self._content_length()
        if length is None:
            return None
        body = self.rfile.read(length)
        if len(body) != length:
            self._error(HTTPStatus.BAD_REQUEST, "incomplete request body")
            return None
        try:
            return json.loads(
                body.decode("utf-8"), parse_constant=Store._reject_constant
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return None

    def _store_failure(self, exc: StoreError) -> None:
        self.log_error("storage error: %s", exc)
        self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage operation failed")

    def do_GET(self) -> None:
        route = self._route()
        if route is None:
            return
        kind, key = route
        try:
            if kind == "health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
            elif kind == "keys":
                self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            else:
                assert key is not None
                found, value = self.server.store.get(key)
                if found:
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
        except StoreError as exc:
            self._store_failure(exc)

    def do_PUT(self) -> None:
        route = self._route()
        if route is None:
            return
        kind, key = route
        if kind != "key":
            self._method_not_allowed(kind)
            return
        document = self._read_document()
        if document is None:
            return
        if not isinstance(document, dict):
            self._error(HTTPStatus.BAD_REQUEST, "body must be a JSON object")
            return
        if "value" not in document or not set(document).issubset({"value", "ttl_seconds"}):
            self._error(HTTPStatus.BAD_REQUEST, "body must contain value and optional ttl_seconds")
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
            return
        try:
            assert key is not None
            created = self.server.store.put(key, document["value"], ttl)
            self._send_json(
                HTTPStatus.CREATED if created else HTTPStatus.OK,
                {"key": key, "value": document["value"]},
            )
        except StoreError as exc:
            self._store_failure(exc)

    def do_DELETE(self) -> None:
        route = self._route()
        if route is None:
            return
        kind, key = route
        if kind != "key":
            self._method_not_allowed(kind)
            return
        try:
            assert key is not None
            if not self.server.store.delete(key):
                self._error(HTTPStatus.NOT_FOUND, "key not found")
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except StoreError as exc:
            self._store_failure(exc)

    def _method_not_allowed(self, kind: str) -> None:
        allowed = "GET, PUT, DELETE" if kind == "key" else "GET"
        payload = json.dumps({"error": "method not allowed"}, separators=(",", ":")).encode()
        self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
        self.send_header("Allow", allowed)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _unsupported(self) -> None:
        route = self._route()
        if route is not None:
            self._method_not_allowed(route[0])

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported
    do_HEAD = _unsupported
    do_CONNECT = _unsupported
    do_TRACE = _unsupported


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
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
        server = KVServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
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
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
