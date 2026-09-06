#!/usr/bin/env python3
"""A small persistent HTTP key-value service using only the standard library."""

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


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Store:
    """Thread-safe in-memory state backed by an atomically replaced JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            entries = document.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("data-file entries must be an object")

            loaded: dict[str, dict[str, Any]] = {}
            now = time.time()
            removed_expired = False
            for key, item in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("data file contains an invalid key")
                if not isinstance(item, dict) or "value" not in item:
                    raise ValueError("data file contains an invalid entry")
                expires_at = item.get("expires_at")
                if expires_at is not None:
                    if (
                        isinstance(expires_at, bool)
                        or not isinstance(expires_at, (int, float))
                        or not math.isfinite(expires_at)
                    ):
                        raise ValueError("data file contains an invalid expiry")
                    if expires_at <= now:
                        removed_expired = True
                        continue
                loaded[key] = {"value": item["value"], "expires_at": expires_at}
            self.entries = loaded
            if removed_expired:
                self._persist_locked()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _purge_expired_locked(self) -> bool:
        now = time.time()
        expired = [
            key
            for key, item in self.entries.items()
            if item["expires_at"] is not None and item["expires_at"] <= now
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "entries": self.entries}
        temp_name: str | None = None
        try:
            descriptor, temp_name = tempfile.mkstemp(
                dir=parent, prefix=f".{self.path.name}.", suffix=".tmp"
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as target:
                json.dump(
                    payload,
                    target,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
                target.write("\n")
                target.flush()
                os.fsync(target.fileno())
            os.replace(temp_name, self.path)
            temp_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some filesystems do not permit fsync on directories. The file
                # itself has still been flushed and atomically replaced.
                pass
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except FileNotFoundError:
                    pass

    def _persist_after_purge_locked(self) -> None:
        if self._purge_expired_locked():
            self._persist_locked()

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self.lock:
            self._persist_after_purge_locked()
            created = key not in self.entries
            previous = self.entries.get(key)
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except Exception:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._persist_after_purge_locked()
            item = self.entries.get(key)
            return (False, None) if item is None else (True, item["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._persist_after_purge_locked()
            previous = self.entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist_locked()
            except Exception:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._persist_after_purge_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: Server

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"{self.client_address[0]} - {format_string % args}",
            file=sys.stderr,
            flush=True,
        )

    def _send_json(self, status: int, body: Any) -> None:
        encoded = json.dumps(
            body, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _send_error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _dispatch(self, method: str) -> None:
        try:
            path = urlsplit(self.path).path
            if path == "/health":
                if method != "GET":
                    raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
                self._send_json(HTTPStatus.OK, {"status": "ok"})
                return
            if path == "/v1/keys":
                if method != "GET":
                    raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
                self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
                return
            if path.startswith(KV_PREFIX):
                key = self._decode_key(path[len(KV_PREFIX) :])
                if method == "PUT":
                    value, ttl_seconds = self._read_put_body()
                    created = self.server.store.put(key, value, ttl_seconds)
                    self._send_json(
                        HTTPStatus.CREATED if created else HTTPStatus.OK,
                        {"key": key, "value": value},
                    )
                    return
                if method == "GET":
                    found, value = self.server.store.get(key)
                    if not found:
                        raise ApiError(HTTPStatus.NOT_FOUND, "key not found")
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                    return
                if method == "DELETE":
                    if not self.server.store.delete(key):
                        raise ApiError(HTTPStatus.NOT_FOUND, "key not found")
                    self.send_response(HTTPStatus.NO_CONTENT)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
            raise ApiError(HTTPStatus.NOT_FOUND, "route not found")
        except ApiError as exc:
            self._send_error(exc.status, exc.message)
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "internal server error")

    @staticmethod
    def _decode_key(encoded: str) -> str:
        if not encoded or "/" in encoded:
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid key")
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                if index + 2 >= len(encoded) or any(
                    character not in "0123456789abcdefABCDEF"
                    for character in encoded[index + 1 : index + 3]
                ):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "invalid key encoding")
                index += 3
            else:
                index += 1
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, "key must be valid UTF-8") from exc
        if not key or "/" in key:
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid key")
        return key

    def _read_put_body(self) -> tuple[Any, float | None]:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise ApiError(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
        try:
            length = int(raw_length, 10)
        except ValueError as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid Content-Length") from exc
        if length < 0:
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ApiError(HTTPStatus.BAD_REQUEST, "incomplete request body")
        try:
            body = json.loads(raw, parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, "malformed JSON") from exc
        if not isinstance(body, dict) or "value" not in body:
            raise ApiError(HTTPStatus.BAD_REQUEST, "body must be an object containing value")
        unexpected = set(body) - {"value", "ttl_seconds"}
        if unexpected:
            raise ApiError(HTTPStatus.BAD_REQUEST, "body contains unknown fields")
        ttl = body.get("ttl_seconds")
        if ttl is not None:
            if (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise ApiError(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
            ttl = float(ttl)
        return body["value"], ttl

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

    def do_OPTIONS(self) -> None:
        self._dispatch("OPTIONS")


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
        server = Server((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"fatal: {exc}", file=sys.stderr, flush=True)
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
