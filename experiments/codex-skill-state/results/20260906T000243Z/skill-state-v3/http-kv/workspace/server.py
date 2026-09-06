#!/usr/bin/env python3
"""A small persistent HTTP key-value service using only the standard library."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(Exception):
    """Raised when persistent state cannot be read or written."""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_live(record: dict[str, Any], now: float) -> bool:
        expires_at = record.get("expires_at")
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                document = json.load(stream, parse_constant=self._invalid_constant)
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("invalid top-level structure")

            loaded: dict[str, dict[str, Any]] = {}
            for key, record in raw_entries.items():
                if (
                    not isinstance(key, str)
                    or not key
                    or "/" in key
                    or not isinstance(record, dict)
                    or "value" not in record
                ):
                    raise ValueError("invalid entry")
                expires_at = record.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiry")
                loaded[key] = {"value": record["value"], "expires_at": expires_at}
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

        now = time.time()
        self.entries = {key: record for key, record in loaded.items() if self._is_live(record, now)}
        if len(self.entries) != len(loaded):
            self._persist(self.entries)

    @staticmethod
    def _invalid_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(
                        {"entries": entries},
                        stream,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                    )
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
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
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    def _purge_locked(self, now: float) -> None:
        live = {key: record for key, record in self.entries.items() if self._is_live(record, now)}
        if len(live) != len(self.entries):
            self._persist(live)
            self.entries = live

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._purge_locked(now)
            created = key not in self.entries
            replacement = dict(self.entries)
            replacement[key] = {
                "value": value,
                "expires_at": None if ttl is None else now + ttl,
            }
            self._persist(replacement)
            self.entries = replacement
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._purge_locked(time.time())
            record = self.entries.get(key)
            return (False, None) if record is None else (True, record["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked(time.time())
            if key not in self.entries:
                return False
            replacement = dict(self.entries)
            del replacement[key]
            self._persist(replacement)
            self.entries = replacement
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._purge_locked(time.time())
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}", file=os.sys.stderr, flush=True)

    def _json(self, status: int, body: Any) -> None:
        payload = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _path(self) -> str:
        try:
            return urlsplit(self.path).path
        except ValueError:
            return ""

    def _key(self) -> tuple[str | None, str | None]:
        path = self._path()
        if not path.startswith(KEY_PREFIX):
            return None, "unknown route"
        encoded = path[len(KEY_PREFIX) :]
        if not encoded:
            return None, "key must not be empty"
        if "/" in encoded or BAD_ESCAPE.search(encoded):
            return None, "invalid key"
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            return None, "key must be valid UTF-8"
        if not key or "/" in key:
            return None, "invalid key"
        return key, None

    def _body(self) -> tuple[Any | None, str | None, int]:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            return None, "transfer encoding is not supported", 400
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return None, "Content-Length is required", 411
        try:
            length = int(raw_length)
        except ValueError:
            self.close_connection = True
            return None, "invalid Content-Length", 400
        if length < 0:
            self.close_connection = True
            return None, "invalid Content-Length", 400
        if length > MAX_BODY:
            self.close_connection = True
            return None, "request body exceeds 1 MiB", 413
        raw = self.rfile.read(length)
        try:
            return json.loads(raw, parse_constant=Store._invalid_constant), None, 0
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            return None, "malformed JSON", 400

    def do_GET(self) -> None:
        path = self._path()
        try:
            if path == "/health":
                self._json(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._json(200, {"keys": self.server.store.keys()})
                return
            if path.startswith(KEY_PREFIX):
                key, error = self._key()
                if error:
                    self._error(400, error)
                    return
                found, value = self.server.store.get(key)
                if not found:
                    self._error(404, "key not found")
                    return
                self._json(200, {"key": key, "value": value})
                return
            self._error(404, "unknown route")
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "persistent storage error")

    def do_PUT(self) -> None:
        key, error = self._key()
        if error:
            self._error(404 if error == "unknown route" else 400, error)
            return
        body, error, status = self._body()
        if error:
            self._error(status, error)
            return
        if not isinstance(body, dict) or "value" not in body:
            self._error(400, "body must be an object containing value")
            return
        ttl = body.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.server.store.put(key, body["value"], ttl)
            self._json(201 if created else 200, {"key": key, "value": body["value"]})
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "persistent storage error")

    def do_DELETE(self) -> None:
        key, error = self._key()
        if error:
            self._error(404 if error == "unknown route" else 400, error)
            return
        try:
            if not self.server.store.delete(key):
                self._error(404, "key not found")
                return
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "persistent storage error")

    def _method_not_allowed(self) -> None:
        self.send_response(405)
        payload = b'{"error":"method not allowed"}'
        self.send_header("Allow", "GET, PUT, DELETE")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed


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
        store = Store(args.data)
        server = Server((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup error: {exc}", file=os.sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def request_stop(_signum: int, _frame: Any) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    worker = threading.Thread(target=server.serve_forever, name="http-server")
    worker.start()
    try:
        stopping.wait()
    finally:
        server.shutdown()
        server.server_close()
        worker.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
