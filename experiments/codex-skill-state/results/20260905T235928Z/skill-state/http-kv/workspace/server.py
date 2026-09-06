#!/usr/bin/env python3
"""A small, dependency-free, persistent HTTP key-value service."""

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
BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


class Store:
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
            with self.path.open("r", encoding="utf-8") as stream:
                raw = json.load(stream, parse_constant=self._reject_constant)
            if not isinstance(raw, dict) or set(raw) != {"entries"}:
                raise ValueError("top-level object must contain only 'entries'")
            entries = raw["entries"]
            if not isinstance(entries, dict):
                raise ValueError("'entries' must be an object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in entries.items():
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
                    raise ValueError("invalid stored expiration")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self._entries = self._live(loaded, time.time())
            if len(self._entries) != len(loaded):
                self._persist(self._entries)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(
                        {"entries": entries},
                        stream,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                        sort_keys=True,
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
                    # Some platforms/filesystems do not support syncing directories.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
                raise
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    def _purge_locked(self) -> None:
        live = self._live(self._entries, time.time())
        if len(live) != len(self._entries):
            self._persist(live)
            self._entries = live

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self._lock:
            self._purge_locked()
            created = key not in self._entries
            updated = self._entries.copy()
            updated[key] = {
                "value": value,
                "expires_at": None if ttl_seconds is None else time.time() + ttl_seconds,
            }
            self._persist(updated)
            self._entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            self._purge_locked()
            entry = self._entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self._lock:
            self._purge_locked()
            if key not in self._entries:
                return False
            updated = self._entries.copy()
            del updated[key]
            self._persist(updated)
            self._entries = updated
            return True

    def keys(self) -> list[str]:
        with self._lock:
            self._purge_locked()
            return sorted(self._entries)


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
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr, flush=True)

    def _json(self, status: int, payload: Any | None = None) -> None:
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, status: int, code: str, message: str) -> None:
        self._json(status, {"error": {"code": code, "message": message}})

    def _route(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        if parsed.path.startswith(KEY_PREFIX):
            encoded = parsed.path[len(KEY_PREFIX):]
            if not encoded or BAD_PERCENT_ESCAPE.search(encoded):
                raise ValueError("key must be non-empty and validly URL-encoded")
            try:
                key = unquote_to_bytes(encoded).decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ValueError("key must decode as UTF-8") from exc
            if not key or "/" in key:
                raise ValueError("key must be non-empty and must not contain '/'")
            return "key", key
        return "unknown", None

    def _read_json(self) -> Any:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            raise RequestFailure(HTTPStatus.BAD_REQUEST, "invalid_body", "chunked bodies are not supported")
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths or not lengths[0].strip():
            raise RequestFailure(HTTPStatus.LENGTH_REQUIRED, "length_required", "Content-Length is required")
        if len(lengths) != 1:
            raise RequestFailure(HTTPStatus.BAD_REQUEST, "invalid_length", "invalid Content-Length")
        raw_length = lengths[0]
        try:
            length = int(raw_length, 10)
        except ValueError as exc:
            raise RequestFailure(HTTPStatus.BAD_REQUEST, "invalid_length", "invalid Content-Length") from exc
        if length < 0:
            raise RequestFailure(HTTPStatus.BAD_REQUEST, "invalid_length", "invalid Content-Length")
        if length > MAX_BODY:
            # Drain the request before replying. Closing a socket with unread
            # request bytes can turn the intended 413 into a TCP reset at the
            # client, especially when the client is still uploading the body.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            raise RequestFailure(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "body_too_large", "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            return json.loads(body.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise RequestFailure(HTTPStatus.BAD_REQUEST, "invalid_json", "body must be valid JSON") from exc

    def _dispatch(self, method: str) -> None:
        try:
            route, key = self._route()
            allowed = {
                "health": {"GET"},
                "keys": {"GET"},
                "key": {"GET", "PUT", "DELETE"},
            }
            if route == "unknown":
                self._error(HTTPStatus.NOT_FOUND, "not_found", "route not found")
                return
            if method not in allowed[route]:
                self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
                self.send_header("Allow", ", ".join(sorted(allowed[route])))
                body = json.dumps({"error": {"code": "method_not_allowed", "message": "method not allowed"}}, separators=(",", ":")).encode()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if route == "health":
                self._json(HTTPStatus.OK, {"status": "ok"})
            elif route == "keys":
                self._json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            elif method == "GET":
                found, value = self.server.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", "key not found")
            elif method == "DELETE":
                if self.server.store.delete(key):  # type: ignore[arg-type]
                    self._json(HTTPStatus.NO_CONTENT)
                else:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", "key not found")
            else:
                payload = self._read_json()
                if not isinstance(payload, dict):
                    raise RequestFailure(HTTPStatus.BAD_REQUEST, "invalid_body", "body must be a JSON object")
                if "value" not in payload or not set(payload).issubset({"value", "ttl_seconds"}):
                    raise RequestFailure(HTTPStatus.BAD_REQUEST, "invalid_body", "body requires 'value' and only supports optional 'ttl_seconds'")
                ttl = payload.get("ttl_seconds")
                if ttl is not None and (
                    isinstance(ttl, bool)
                    or not isinstance(ttl, (int, float))
                    or not math.isfinite(ttl)
                    or ttl <= 0
                ):
                    raise RequestFailure(HTTPStatus.BAD_REQUEST, "invalid_ttl", "ttl_seconds must be finite and greater than zero")
                created = self.server.store.put(key, payload["value"], ttl)  # type: ignore[arg-type]
                self._json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": payload["value"]})
        except ValueError as exc:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_key", str(exc))
        except RequestFailure as exc:
            self._error(exc.status, exc.code, exc.message)
        except StoreError as exc:
            print(str(exc), file=sys.stderr, flush=True)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "persistent storage operation failed")

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def do_OPTIONS(self) -> None:
        self._dispatch("OPTIONS")


class RequestFailure(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        self.status = status
        self.code = code
        self.message = message


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
        store = Store(args.data)
        server = Server((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr, flush=True)
        return 1

    def stop(_signum: int, _frame: Any) -> None:
        # shutdown() must run outside the serve_forever() thread.
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
