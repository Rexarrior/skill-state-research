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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StorageError(RuntimeError):
    """Raised when persistent state cannot be read or written."""


class Store:
    def __init__(self, data_path: Path):
        self.data_path = data_path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _now() -> float:
        return time.time()

    def _load(self) -> None:
        if not self.data_path.exists():
            return
        try:
            with self.data_path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._reject_constant)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise StorageError(f"cannot load data file {self.data_path}: {exc}") from exc

        if not isinstance(document, dict) or set(document) != {"entries"}:
            raise StorageError("data file has an invalid top-level structure")
        raw_entries = document["entries"]
        if not isinstance(raw_entries, dict):
            raise StorageError("data file entries must be an object")

        now = self._now()
        loaded: dict[str, dict[str, Any]] = {}
        for key, entry in raw_entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise StorageError("data file contains an invalid key")
            if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                raise StorageError(f"data file contains an invalid entry for {key!r}")
            expires_at = entry["expires_at"]
            if expires_at is not None and (
                isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or not math.isfinite(expires_at)
            ):
                raise StorageError(f"data file contains an invalid expiry for {key!r}")
            if expires_at is None or expires_at > now:
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        self.entries = loaded

        # Rewrite once on startup when expired records were found.
        if len(loaded) != len(raw_entries):
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number {value}")

    def _purge_expired_locked(self) -> bool:
        now = self._now()
        expired = [
            key
            for key, entry in self.entries.items()
            if entry["expires_at"] is not None and entry["expires_at"] <= now
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.data_path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.data_path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(
                        {"entries": self.entries},
                        handle,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                    )
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary_name, self.data_path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    # Directory fsync is not supported on every platform.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except (OSError, TypeError, ValueError) as exc:
            raise StorageError(f"cannot persist data file {self.data_path}: {exc}") from exc

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            if self._purge_expired_locked():
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_expired_locked():
                self._persist_locked()
            return sorted(self.entries)

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self.lock:
            self._purge_expired_locked()
            created = key not in self.entries
            previous = self.entries.get(key)
            expires_at = None if ttl_seconds is None else self._now() + ttl_seconds
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except BaseException:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return created

    def delete(self, key: str) -> bool:
        with self.lock:
            purged = self._purge_expired_locked()
            if key not in self.entries:
                if purged:
                    self._persist_locked()
                return False
            previous = self.entries.pop(key)
            try:
                self._persist_locked()
            except BaseException:
                self.entries[key] = previous
                raise
            return True

    def flush(self) -> None:
        with self.lock:
            self._purge_expired_locked()
            self._persist_locked()


class KVHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        super().__init__(address, RequestHandler)
        self.store = store


class RequestHandler(BaseHTTPRequestHandler):
    server: KVHTTPServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(
            f"{self.client_address[0]} - {self.log_date_time_string()} - {fmt % args}",
            file=sys.stderr,
            flush=True,
        )

    @staticmethod
    def _decode_key(path: str) -> tuple[str | None, str | None]:
        if not path.startswith(KEY_PREFIX):
            return None, "unknown route"
        encoded = path[len(KEY_PREFIX) :]
        if not encoded:
            return None, "key must not be empty"
        if "/" in encoded:
            return None, "key must not contain '/'"
        if BAD_PERCENT_ESCAPE.search(encoded):
            return None, "key contains an invalid percent escape"
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return None, "key must be valid UTF-8"
        if not key:
            return None, "key must not be empty"
        if "/" in key:
            return None, "key must not contain '/'"
        return key, None

    def _route(self) -> tuple[str, str | None, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None, "query strings and fragments are not supported"
        if parsed.path == "/health":
            return "health", None, None
        if parsed.path == "/v1/keys":
            return "keys", None, None
        if parsed.path.startswith(KEY_PREFIX):
            key, error = self._decode_key(parsed.path)
            return "kv", key, error
        return "unknown", None, "unknown route"

    def _send_json(
        self, status: int, payload: Any, extra_headers: dict[str, str] | None = None
    ) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str, **headers: str) -> None:
        # An error can be produced before a request body has been consumed
        # (for example, for an invalid key or unsupported method).  Do not let
        # unread bytes be interpreted as the next request on an HTTP/1.1
        # connection.
        self.close_connection = True
        response_headers = {"Connection": "close"}
        response_headers.update(headers)
        self._send_json(status, {"error": message}, response_headers)

    def _read_json_body(self) -> tuple[Any, str | None, int | None]:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            return None, "transfer encoding is not supported", 400
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return None, "Content-Length is required", 411
        try:
            length = int(raw_length, 10)
        except ValueError:
            return None, "invalid Content-Length", 400
        if length < 0:
            return None, "invalid Content-Length", 400
        if length > MAX_BODY_BYTES:
            # Draining a modest overrun lets ordinary HTTP clients finish
            # sending and reliably receive the 413 response.  Do not drain an
            # unbounded declared body, since a peer could then hold a worker
            # open indefinitely.
            if length <= MAX_BODY_BYTES * 2:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(remaining, 64 * 1024))
                    if not chunk:
                        break
                    remaining -= len(chunk)
            self.close_connection = True
            return None, "request body exceeds 1 MiB", 413
        body = self.rfile.read(length)
        if len(body) != length:
            return None, "incomplete request body", 400
        try:
            text = body.decode("utf-8", errors="strict")
            return json.loads(text, parse_constant=Store._reject_constant), None, None
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            return None, "malformed JSON body", 400

    def _guard_storage(self, operation: Any) -> Any:
        try:
            return operation()
        except StorageError as exc:
            print(f"storage error: {exc}", file=sys.stderr, flush=True)
            self._error(500, "persistent storage failure")
            return None

    def do_GET(self) -> None:
        route, key, error = self._route()
        if error:
            self._error(400 if route == "kv" else 404, error)
            return
        if route == "health":
            self._send_json(200, {"status": "ok"})
            return
        if route == "keys":
            keys = self._guard_storage(self.server.store.keys)
            if keys is not None:
                self._send_json(200, {"keys": keys})
            return
        assert route == "kv" and key is not None
        result = self._guard_storage(lambda: self.server.store.get(key))
        if result is None:
            return
        found, value = result
        if not found:
            self._error(404, "key not found")
        else:
            self._send_json(200, {"key": key, "value": value})

    def do_PUT(self) -> None:
        route, key, error = self._route()
        if route != "kv":
            self._error(404, error or "unknown route")
            return
        if error or key is None:
            self._error(400, error or "invalid key")
            return
        document, body_error, status = self._read_json_body()
        if body_error:
            self._error(status or 400, body_error)
            return
        if not isinstance(document, dict):
            self._error(400, "request body must be a JSON object")
            return
        if "value" not in document or not set(document).issubset({"value", "ttl_seconds"}):
            self._error(400, "request body must contain value and optional ttl_seconds")
            return
        has_ttl = "ttl_seconds" in document
        ttl = document.get("ttl_seconds")
        if has_ttl and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        created = self._guard_storage(
            lambda: self.server.store.put(key, document["value"], ttl)
        )
        if created is not None:
            self._send_json(201 if created else 200, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        route, key, error = self._route()
        if route != "kv":
            self._error(404, error or "unknown route")
            return
        if error or key is None:
            self._error(400, error or "invalid key")
            return
        deleted = self._guard_storage(lambda: self.server.store.delete(key))
        if deleted is None:
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unsupported(self) -> None:
        route, _, error = self._route()
        if route == "unknown" or error:
            self._error(404 if route == "unknown" else 400, error or "unknown route")
            return
        allowed = {
            "health": "GET",
            "keys": "GET",
            "kv": "GET, PUT, DELETE",
        }[route]
        self._error(405, "method not allowed", Allow=allowed)

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", default="127.0.0.1", help="address to bind")
    parser.add_argument("--port", type=int, required=True, help="port to bind (0 selects a free port)")
    parser.add_argument("--data", type=Path, required=True, help="JSON persistence file")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = Store(args.data)
        server = KVHTTPServer((args.host, args.port), store)
    except (OSError, StorageError) as exc:
        print(f"startup error: {exc}", file=sys.stderr, flush=True)
        return 1

    def stop_server(signum: int, frame: Any) -> None:
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop_server)
    signal.signal(signal.SIGINT, stop_server)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    exit_code = 0
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        try:
            store.flush()
        except StorageError as exc:
            print(f"shutdown storage error: {exc}", file=sys.stderr, flush=True)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
