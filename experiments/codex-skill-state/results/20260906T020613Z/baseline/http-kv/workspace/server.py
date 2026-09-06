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
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
KV_PREFIX = "/v1/kv/"


class StoreError(RuntimeError):
    pass


class PersistentStore:
    """Thread-safe JSON store whose on-disk state contains live entries only."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._reject_constant)
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("expected an object containing an entries object")

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
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

        now = time.time()
        self._entries = {
            key: entry for key, entry in loaded.items() if self._live(entry, now)
        }
        if len(self._entries) != len(loaded):
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON number {value}")

    def _purge_locked(self, now: float) -> bool:
        expired = [
            key for key, entry in self._entries.items() if not self._live(entry, now)
        ]
        for key in expired:
            del self._entries[key]
        if expired:
            self._persist_locked()
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                dir=parent, prefix=f".{self.path.name}.", suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(
                        {"entries": self._entries},
                        handle,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                    )
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary_name, self.path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    # Directory fsync is unavailable on some platforms/filesystems.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass
                raise
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    def put(self, key: str, value: Any, ttl_seconds: float | int | None) -> bool:
        with self._lock:
            now = time.time()
            self._purge_locked(now)
            created = key not in self._entries
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            previous = self._entries.get(key)
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
            self._purge_locked(time.time())
            entry = self._entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self._lock:
            self._purge_locked(time.time())
            previous = self._entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist_locked()
            except StoreError:
                self._entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            self._purge_locked(time.time())
            return sorted(self._entries)


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

    def log_message(self, message: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] " + message % args,
            file=sys.stderr,
            flush=True,
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

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _path(self) -> str | None:
        try:
            return urlsplit(self.path).path
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid request target")
            return None

    def _key(self, path: str) -> str | None:
        raw = path[len(KV_PREFIX) :]
        # urllib deliberately tolerates malformed percent escapes; the API does not.
        index = 0
        while index < len(raw):
            if raw[index] == "%":
                if index + 2 >= len(raw) or any(
                    char not in "0123456789abcdefABCDEF" for char in raw[index + 1 : index + 3]
                ):
                    self._error(HTTPStatus.BAD_REQUEST, "invalid URL-encoded key")
                    return None
                index += 3
            else:
                index += 1
        try:
            key = unquote_to_bytes(raw).decode("utf-8")
        except UnicodeDecodeError:
            self._error(HTTPStatus.BAD_REQUEST, "key must be valid UTF-8")
            return None
        if not key or "/" in key:
            self._error(HTTPStatus.BAD_REQUEST, "key must be non-empty and cannot contain '/'")
            return None
        return key

    def _read_json_object(self) -> dict[str, Any] | None:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            self._error(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            return None
        try:
            length = int(raw_length)
            if length < 0:
                raise ValueError
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            return None
        try:
            raw = self.rfile.read(length)
            document = json.loads(raw, parse_constant=PersistentStore._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return None
        if not isinstance(document, dict):
            self._error(HTTPStatus.BAD_REQUEST, "request body must be a JSON object")
            return None
        return document

    def _route_key(self) -> str | None:
        path = self._path()
        if path is None:
            return None
        if not path.startswith(KV_PREFIX):
            self._error(HTTPStatus.NOT_FOUND, "route not found")
            return None
        return self._key(path)

    def do_GET(self) -> None:
        path = self._path()
        if path is None:
            return
        try:
            if path == "/health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
            elif path == "/v1/keys":
                self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            elif path.startswith(KV_PREFIX):
                key = self._key(path)
                if key is None:
                    return
                found, value = self.server.store.get(key)
                if found:
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            else:
                self._error(HTTPStatus.NOT_FOUND, "route not found")
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def do_PUT(self) -> None:
        key = self._route_key()
        if key is None:
            # A rejected route may still carry a body; do not interpret it as the
            # next request on a persistent connection.
            self.close_connection = True
            return
        document = self._read_json_object()
        if document is None:
            return
        if "value" not in document or not set(document).issubset({"value", "ttl_seconds"}):
            self._error(
                HTTPStatus.BAD_REQUEST,
                "body must contain value and optionally ttl_seconds",
            )
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
            created = self.server.store.put(key, document["value"], ttl)
            self._send_json(
                HTTPStatus.CREATED if created else HTTPStatus.OK,
                {"key": key, "value": document["value"]},
            )
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def do_DELETE(self) -> None:
        key = self._route_key()
        if key is None:
            return
        try:
            if self.server.store.delete(key):
                self._send_empty(HTTPStatus.NO_CONTENT)
            else:
                self._error(HTTPStatus.NOT_FOUND, "key not found")
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def _method_not_allowed(self) -> None:
        self.close_connection = True
        self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
        self.send_header("Allow", "GET, PUT, DELETE")
        encoded = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_CONNECT = _method_not_allowed
    do_TRACE = _method_not_allowed


class ShutdownRequested(Exception):
    pass


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True, type=Path)
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        store = PersistentStore(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"fatal: {exc}", file=sys.stderr, flush=True)
        return 1

    def request_shutdown(_signum: int, _frame: Any) -> None:
        raise ShutdownRequested

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    except (ShutdownRequested, KeyboardInterrupt):
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
