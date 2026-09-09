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


MAX_BODY = 1024 * 1024
HEX_DIGITS = frozenset("0123456789abcdefABCDEF")


class StoreError(Exception):
    """Raised when durable state cannot be loaded or saved."""


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._invalid_constant)
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("invalid top-level structure")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid stored key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid stored entry")
                expiry = entry["expires_at"]
                if expiry is not None and (
                    isinstance(expiry, bool)
                    or not isinstance(expiry, (int, float))
                    or not math.isfinite(expiry)
                ):
                    raise ValueError("invalid stored expiry")
                loaded[key] = {"value": entry["value"], "expires_at": expiry}
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise StoreError(f"cannot load data file {self.path}: {error}") from error

        now = time.time()
        self.entries = {key: entry for key, entry in loaded.items() if self._live(entry, now)}
        if len(self.entries) != len(loaded):
            self._persist()

    @staticmethod
    def _invalid_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist(self) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                    json.dump(
                        {"entries": self.entries},
                        output,
                        ensure_ascii=False,
                        separators=(",", ":"),
                        allow_nan=False,
                    )
                    output.write("\n")
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary_name, self.path)
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
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except (OSError, TypeError, ValueError) as error:
            raise StoreError(f"cannot persist data file {self.path}: {error}") from error

    def _prune(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        if not expired:
            return False
        previous = self.entries.copy()
        for key in expired:
            del self.entries[key]
        try:
            self._persist()
        except StoreError:
            self.entries = previous
            raise
        return True

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._prune(time.time())
            if key not in self.entries:
                return False, None
            return True, self.entries[key]["value"]

    def keys(self) -> list[str]:
        with self.lock:
            self._prune(time.time())
            return sorted(self.entries)

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self.lock:
            self._prune(time.time())
            existed = key in self.entries
            previous = self.entries.get(key)
            expiry = None if ttl_seconds is None else time.time() + ttl_seconds
            self.entries[key] = {"value": value, "expires_at": expiry}
            try:
                self._persist()
            except StoreError:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return existed

    def delete(self, key: str) -> bool:
        with self.lock:
            self._prune(time.time())
            if key not in self.entries:
                return False
            previous = self.entries.pop(key)
            try:
                self._persist()
            except StoreError:
                self.entries[key] = previous
                raise
            return True


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string: str, *args: Any) -> None:
        sys.stderr.write(
            "%s - - [%s] %s\n"
            % (self.address_string(), self.log_date_time_string(), format_string % args)
        )

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

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
            return "invalid_key", None
        for index, character in enumerate(encoded):
            if character == "%" and (
                index + 2 >= len(encoded)
                or encoded[index + 1] not in HEX_DIGITS
                or encoded[index + 2] not in HEX_DIGITS
            ):
                return "invalid_key", None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            return "invalid_key", None
        if not key or "/" in key:
            return "invalid_key", None
        return "kv", key

    def _read_json(self) -> tuple[bool, Any]:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            self._error(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
            self.close_connection = True
            return False, None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            self.close_connection = True
            return False, None
        try:
            length = int(raw_length, 10)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            self.close_connection = True
            return False, None
        if length < 0:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            self.close_connection = True
            return False, None
        if length > MAX_BODY:
            # Consume the request body without buffering it so that clients which
            # transmit headers and body together can receive the 413 response
            # instead of seeing a connection reset while still writing.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            self.close_connection = True
            return False, None
        try:
            raw = self.rfile.read(length)
            text = raw.decode("utf-8")
            value = json.loads(text, parse_constant=Store._invalid_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return False, None
        return True, value

    def _dispatch(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            return
        if route == "unknown":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
            return
        allowed = {
            "health": {"GET"},
            "keys": {"GET"},
            "kv": {"GET", "PUT", "DELETE"},
        }[route]
        if self.command not in allowed:
            self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
            self.send_header("Allow", ", ".join(sorted(allowed)))
            body = json.dumps({"error": "method not allowed"}, separators=(",", ":")).encode()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        try:
            if route == "health":
                self._json(HTTPStatus.OK, {"status": "ok"})
            elif route == "keys":
                self._json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            elif self.command == "GET":
                found, value = self.server.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            elif self.command == "DELETE":
                if self.server.store.delete(key):  # type: ignore[arg-type]
                    self.send_response(HTTPStatus.NO_CONTENT)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            else:
                valid, body = self._read_json()
                if not valid:
                    return
                if not isinstance(body, dict) or "value" not in body or not set(body) <= {
                    "value",
                    "ttl_seconds",
                }:
                    self._error(HTTPStatus.BAD_REQUEST, "body must contain value and optional ttl_seconds")
                    return
                ttl = body.get("ttl_seconds")
                if ttl is not None and (
                    isinstance(ttl, bool)
                    or not isinstance(ttl, (int, float))
                    or not math.isfinite(ttl)
                    or ttl <= 0
                ):
                    self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
                    return
                replaced = self.server.store.put(key, body["value"], ttl)  # type: ignore[arg-type]
                self._json(HTTPStatus.OK if replaced else HTTPStatus.CREATED, {"key": key, "value": body["value"]})
        except StoreError as error:
            self.log_error("storage error: %s", error)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    do_GET = _dispatch
    do_PUT = _dispatch
    do_DELETE = _dispatch
    do_POST = _dispatch
    do_PATCH = _dispatch
    do_OPTIONS = _dispatch
    do_HEAD = _dispatch


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
        store = Store(args.data.expanduser().resolve())
        server = Server((args.host, args.port), store)
    except (OSError, StoreError) as error:
        print(f"startup error: {error}", file=sys.stderr)
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
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
