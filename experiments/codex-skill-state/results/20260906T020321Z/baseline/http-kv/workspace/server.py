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
_VALID_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class PersistenceError(RuntimeError):
    """Raised when durable state cannot be read or written."""


def _reject_non_json_number(value: str) -> None:
    raise ValueError(f"{value} is not a valid JSON number")


def _json_loads(data: str) -> Any:
    return json.loads(data, parse_constant=_reject_non_json_number)


class Store:
    """Thread-safe, atomically persisted key-value state."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = self.path.read_text(encoding="utf-8")
            document = _json_loads(raw)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("expected a version 1 store object")
            entries = document.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("'entries' must be an object")

            loaded: dict[str, dict[str, Any]] = {}
            now = time.time()
            removed_expired = False
            for key, entry in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("stored key is invalid")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError(f"stored entry for {key!r} is invalid")
                expires_at = entry["expires_at"]
                if expires_at is not None:
                    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
                        raise ValueError(f"stored expiry for {key!r} is invalid")
                    try:
                        finite = math.isfinite(expires_at)
                    except OverflowError:
                        finite = False
                    if not finite:
                        raise ValueError(f"stored expiry for {key!r} is invalid")
                normalized = {"value": entry["value"], "expires_at": expires_at}
                if self._is_live(normalized, now):
                    loaded[key] = normalized
                else:
                    removed_expired = True
            # Also validate that all values can be emitted as standards-compliant JSON.
            json.dumps(loaded, allow_nan=False)
            self._entries = loaded
            if removed_expired:
                self._persist(loaded)
        except (OSError, UnicodeError, ValueError, TypeError, RecursionError) as exc:
            raise PersistenceError(f"cannot load data file {self.path}: {exc}") from exc

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(
                {"version": 1, "entries": entries},
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
            temporary_name: str | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="wb",
                    dir=parent,
                    prefix=f".{self.path.name}.",
                    suffix=".tmp",
                    delete=False,
                ) as temporary:
                    temporary_name = temporary.name
                    temporary.write(payload)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_name, self.path)
                temporary_name = None
                # Make the directory entry durable where directory fsync is supported.
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    pass
            finally:
                if temporary_name is not None:
                    try:
                        os.unlink(temporary_name)
                    except FileNotFoundError:
                        pass
        except (OSError, ValueError, TypeError, RecursionError) as exc:
            raise PersistenceError(f"cannot persist data file {self.path}: {exc}") from exc

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self._lock:
            now = time.time()
            live = {k: v for k, v in self._entries.items() if self._is_live(v, now)}
            created = key not in live
            if ttl_seconds is None:
                expires_at = None
            else:
                try:
                    expires_at = now + ttl_seconds
                except OverflowError:
                    expires_at = sys.float_info.max
                if not math.isfinite(expires_at):
                    expires_at = sys.float_info.max
            live[key] = {"value": value, "expires_at": expires_at}
            self._persist(live)
            self._entries = live
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or not self._is_live(entry, time.time()):
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            now = time.time()
            live = {k: v for k, v in self._entries.items() if self._is_live(v, now)}
            if key not in live:
                if len(live) != len(self._entries):
                    self._persist(live)
                self._entries = live
                return False
            del live[key]
            self._persist(live)
            self._entries = live
            return True

    def keys(self) -> list[str]:
        with self._lock:
            now = time.time()
            return sorted(k for k, entry in self._entries.items() if self._is_live(entry, now))

    def prune(self) -> None:
        with self._lock:
            now = time.time()
            live = {k: v for k, v in self._entries.items() if self._is_live(v, now)}
            if len(live) != len(self._entries):
                self._persist(live)
                self._entries = live


class KVHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = False
    block_on_close = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        super().__init__(address, KVRequestHandler)
        self.store = store


class KVRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(10)

    def _send_json(self, status: int, body: Any | None) -> None:
        encoded = b"" if body is None else json.dumps(
            body, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD" and encoded:
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _close_with_unread_body(self) -> None:
        """Prevent an unread body from becoming the next keep-alive request."""
        if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Length") not in (None, "0"):
            self.close_connection = True

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        # BaseHTTPRequestHandler otherwise emits HTML and uses 501 for unknown verbs.
        if code == HTTPStatus.NOT_IMPLEMENTED:
            code = HTTPStatus.METHOD_NOT_ALLOWED
            self.close_connection = True
        text = message or HTTPStatus(code).phrase
        self._error(code, text)

    def _route(self) -> tuple[str, str | None]:
        try:
            target = urlsplit(self.path)
        except ValueError:
            return "unknown", None
        if target.scheme or target.netloc or target.query or target.fragment:
            return "unknown", None
        if target.path == "/health":
            return "health", None
        if target.path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if not target.path.startswith(prefix):
            return "unknown", None
        encoded_key = target.path[len(prefix) :]
        if not encoded_key:
            return "invalid_key", None
        if "/" in encoded_key or _VALID_PERCENT_ESCAPE.search(encoded_key):
            return "invalid_key", None
        try:
            key = unquote_to_bytes(encoded_key).decode("utf-8")
        except UnicodeDecodeError:
            return "invalid_key", None
        if not key or "/" in key:
            return "invalid_key", None
        return "key", key

    def _read_json_body(self) -> Any:
        transfer_encodings = self.headers.get_all("Transfer-Encoding", failobj=[])
        if transfer_encodings:
            self.close_connection = True
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "Transfer-Encoding is not supported")
        lengths = self.headers.get_all("Content-Length", failobj=[])
        if len(lengths) != 1:
            self.close_connection = True
            raise RequestProblem(HTTPStatus.LENGTH_REQUIRED, "exactly one Content-Length is required")
        try:
            length = int(lengths[0], 10)
        except ValueError as exc:
            self.close_connection = True
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "invalid Content-Length") from exc
        if length < 0:
            self.close_connection = True
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            raise RequestProblem(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self.close_connection = True
            raise RequestProblem(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json")
        raw = self.rfile.read(length)
        if len(raw) != length:
            self.close_connection = True
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "incomplete request body")
        try:
            text = raw.decode("utf-8")
            return _json_loads(text)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
            raise RequestProblem(HTTPStatus.BAD_REQUEST, "malformed JSON") from exc

    def _handle(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._close_with_unread_body()
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            return
        if route == "unknown":
            self._close_with_unread_body()
            self._error(HTTPStatus.NOT_FOUND, "unknown route")
            return

        allowed = {
            "health": {"GET"},
            "keys": {"GET"},
            "key": {"GET", "PUT", "DELETE"},
        }[route]
        if self.command not in allowed:
            self._close_with_unread_body()
            self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
            self.send_header("Allow", ", ".join(sorted(allowed)))
            encoded = b'{"error":"method not allowed"}'
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(encoded)
            return

        try:
            if route == "health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
            elif route == "keys":
                self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            elif self.command == "GET":
                found, value = self.server.store.get(key)
                if found:
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            elif self.command == "DELETE":
                if self.server.store.delete(key):
                    self._send_json(HTTPStatus.NO_CONTENT, None)
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            else:
                body = self._read_json_body()
                if not isinstance(body, dict) or "value" not in body or not set(body) <= {"value", "ttl_seconds"}:
                    raise RequestProblem(HTTPStatus.BAD_REQUEST, "body must contain value and optional ttl_seconds")
                ttl = body.get("ttl_seconds")
                if "ttl_seconds" in body:
                    if isinstance(ttl, bool) or not isinstance(ttl, (int, float)):
                        raise RequestProblem(HTTPStatus.BAD_REQUEST, "ttl_seconds must be a number greater than zero")
                    try:
                        valid_ttl = math.isfinite(ttl) and ttl > 0
                    except OverflowError:
                        valid_ttl = ttl > 0
                    if not valid_ttl:
                        raise RequestProblem(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
                # Validate response/persistence serialization before changing state.
                try:
                    json.dumps(body["value"], allow_nan=False)
                except (ValueError, TypeError, RecursionError) as exc:
                    raise RequestProblem(HTTPStatus.BAD_REQUEST, "value is not valid JSON") from exc
                created = self.server.store.put(key, body["value"], ttl)
                self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": body["value"]})
        except RequestProblem as exc:
            self._error(exc.status, exc.message)
        except PersistenceError as exc:
            print(f"persistence error: {exc}", file=sys.stderr, flush=True)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "persistence failure")

    do_GET = _handle
    do_PUT = _handle
    do_DELETE = _handle
    do_POST = _handle
    do_PATCH = _handle
    do_OPTIONS = _handle
    do_HEAD = _handle
    do_TRACE = _handle
    do_CONNECT = _handle

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr, flush=True)


class RequestProblem(Exception):
    def __init__(self, status: int, message: str) -> None:
        self.status = status
        self.message = message
        super().__init__(message)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True)
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        store = Store(args.data)
        server = KVHTTPServer((args.host, args.port), store)
    except (OSError, PersistenceError) as exc:
        print(f"startup error: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def reap_expired() -> None:
        while not stopping.wait(0.1):
            try:
                store.prune()
            except PersistenceError as exc:
                print(f"persistence error while pruning: {exc}", file=sys.stderr, flush=True)

    reaper = threading.Thread(target=reap_expired, name="expiry-reaper", daemon=True)
    reaper.start()
    actual_port = server.server_address[1]
    print(f"LISTENING {actual_port}", flush=True)
    exit_code = 0
    server.timeout = 0.1
    try:
        while not stopping.is_set():
            server.handle_request()
    except KeyboardInterrupt:
        stopping.set()
    finally:
        stopping.set()
        server.server_close()
        reaper.join(timeout=1)
        try:
            store.prune()
        except PersistenceError as exc:
            print(f"persistence error during shutdown: {exc}", file=sys.stderr, flush=True)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
