#!/usr/bin/env python3
"""A small, persistent HTTP key-value service."""

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
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024
_BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")
_NO_JSON = object()


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


@dataclass
class Entry:
    value: Any
    expires_at: float | None


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, Entry] = {}
        self._load()

    @staticmethod
    def _expired(entry: Entry, now: float) -> bool:
        return entry.expires_at is not None and entry.expires_at <= now

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
            loaded: dict[str, Entry] = {}
            for key, raw in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("data file contains an invalid key")
                if not isinstance(raw, dict) or set(raw) != {"value", "expires_at"}:
                    raise ValueError("data file contains an invalid entry")
                expires_at = raw["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("data file contains an invalid expiration")
                loaded[key] = Entry(raw["value"], expires_at)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

        now = time.time()
        self.entries = {
            key: entry for key, entry in loaded.items() if not self._expired(entry, now)
        }
        if len(self.entries) != len(loaded):
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON number {value}")

    def _document(self) -> dict[str, Any]:
        return {
            "version": 1,
            "entries": {
                key: {"value": entry.value, "expires_at": entry.expires_at}
                for key, entry in self.entries.items()
            },
        }

    def _persist_locked(self) -> None:
        parent = self.path.parent
        temporary: str | None = None
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=parent)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(
                    self._document(), output, ensure_ascii=False, separators=(",", ":"),
                    allow_nan=False,
                )
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            temporary = None
            # Ensure the directory entry is durable where the platform supports it.
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def _purge_locked(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if self._expired(entry, now)]
        if not expired:
            return False
        old = self.entries.copy()
        for key in expired:
            del self.entries[key]
        try:
            self._persist_locked()
        except StoreError:
            self.entries = old
            raise
        return True

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._purge_locked(now)
            created = key not in self.entries
            previous = self.entries.get(key)
            self.entries[key] = Entry(value, now + ttl if ttl is not None else None)
            try:
                self._persist_locked()
            except StoreError:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._purge_locked(time.time())
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry.value)

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked(time.time())
            previous = self.entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist_locked()
            except StoreError:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._purge_locked(time.time())
            return sorted(self.entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "http-kv/1.0"

    @property
    def kv_server(self) -> KVServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))

    def _send_json(self, status: int, payload: Any, extra_headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str, headers: dict[str, str] | None = None) -> None:
        self._send_json(status, {"error": message}, headers)

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
            return _NO_JSON
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1:
            self._error(HTTPStatus.LENGTH_REQUIRED if not lengths else HTTPStatus.BAD_REQUEST,
                        "exactly one Content-Length header is required")
            return _NO_JSON
        try:
            length = int(lengths[0], 10)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return _NO_JSON
        if length < 0:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return _NO_JSON
        if length > MAX_BODY:
            self.close_connection = True
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            return _NO_JSON
        raw = self.rfile.read(length)
        if len(raw) != length:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "incomplete request body")
            return _NO_JSON
        try:
            return json.loads(raw.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return _NO_JSON

    def send_error(self, code: int, message: str | None = None,
                   explain: str | None = None) -> None:
        """Keep errors generated by BaseHTTPRequestHandler JSON-formatted too."""
        if code == HTTPStatus.NOT_IMPLEMENTED:
            code = HTTPStatus.METHOD_NOT_ALLOWED
            message = "method not allowed"
        if message is None:
            try:
                message = HTTPStatus(code).phrase
            except ValueError:
                message = "request error"
        self._error(code, message)

    def _route(self) -> tuple[str, str | None] | None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return None
        if parsed.path in ("/health", "/v1/keys"):
            return parsed.path, None
        prefix = "/v1/kv/"
        if not parsed.path.startswith(prefix):
            return None
        encoded = parsed.path[len(prefix):]
        if not encoded or "/" in encoded or _BAD_PERCENT_ESCAPE.search(encoded):
            return "invalid-key", None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return "invalid-key", None
        if not key or "/" in key:
            return "invalid-key", None
        return "/v1/kv", key

    def _dispatch(self) -> None:
        route = self._route()
        if route is None:
            self.close_connection = True
            self._error(HTTPStatus.NOT_FOUND, "unknown route")
            return
        name, key = route
        if name == "invalid-key":
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            return
        allowed = {
            "/health": {"GET"},
            "/v1/keys": {"GET"},
            "/v1/kv": {"GET", "PUT", "DELETE"},
        }[name]
        if self.command not in allowed:
            self.close_connection = True
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed",
                        {"Allow": ", ".join(sorted(allowed))})
            return
        try:
            if name == "/health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
            elif name == "/v1/keys":
                self._send_json(HTTPStatus.OK, {"keys": self.kv_server.store.keys()})
            elif self.command == "GET":
                found, value = self.kv_server.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            elif self.command == "DELETE":
                if self.kv_server.store.delete(key):  # type: ignore[arg-type]
                    self.send_response(HTTPStatus.NO_CONTENT)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            else:
                request = self._read_json()
                if request is _NO_JSON:
                    return
                if (
                    not isinstance(request, dict)
                    or "value" not in request
                    or not set(request) <= {"value", "ttl_seconds"}
                ):
                    self._error(HTTPStatus.BAD_REQUEST, "body must contain value and optional ttl_seconds")
                    return
                ttl = request.get("ttl_seconds")
                if ttl is not None and (
                    isinstance(ttl, bool)
                    or not isinstance(ttl, (int, float))
                    or not math.isfinite(ttl)
                    or ttl <= 0
                ):
                    self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be a finite positive number")
                    return
                created = self.kv_server.store.put(key, request["value"], ttl)  # type: ignore[arg-type]
                self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK,
                                {"key": key, "value": request["value"]})
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
    except (OSError, StoreError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    def stop(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
