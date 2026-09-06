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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as handle:
            document = json.load(handle, parse_constant=self._reject_constant)
        if not isinstance(document, dict) or set(document) != {"entries"}:
            raise ValueError("data file has an invalid format")
        entries = document["entries"]
        if not isinstance(entries, dict):
            raise ValueError("data file has an invalid entries object")

        now = time.time()
        cleaned: dict[str, dict[str, Any]] = {}
        discarded = False
        for key, record in entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise ValueError("data file contains an invalid key")
            if not isinstance(record, dict) or set(record) != {"value", "expires_at"}:
                raise ValueError("data file contains an invalid entry")
            expires_at = record["expires_at"]
            if expires_at is not None and (
                isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or not math.isfinite(expires_at)
            ):
                raise ValueError("data file contains an invalid expiration")
            if expires_at is not None and expires_at <= now:
                discarded = True
                continue
            cleaned[key] = record
        self.entries = cleaned
        if discarded:
            self._persist()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    def _persist(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=parent)
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
            os.replace(temporary, self.path)
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
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    @staticmethod
    def _is_live(record: dict[str, Any], now: float) -> bool:
        expires_at = record["expires_at"]
        return expires_at is None or expires_at > now

    def _purge_expired(self, now: float) -> bool:
        expired = [key for key, record in self.entries.items() if not self._is_live(record, now)]
        if not expired:
            return False
        previous = {key: self.entries.pop(key) for key in expired}
        try:
            self._persist()
        except BaseException:
            self.entries.update(previous)
            raise
        return True

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._purge_expired(now)
            created = key not in self.entries
            previous = self.entries.get(key)
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl is None else now + ttl,
            }
            try:
                self._persist()
            except BaseException:
                if previous is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._purge_expired(time.time())
            if key not in self.entries:
                return False, None
            return True, self.entries[key]["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_expired(time.time())
            previous = self.entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist()
            except BaseException:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._purge_expired(time.time())
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def _json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _path(self) -> tuple[str, str | None]:
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
        raw = parsed.path[len(prefix):]
        if not raw or "/" in raw:
            return "bad_key", None
        try:
            raw_bytes = unquote_to_bytes(raw)
            key = raw_bytes.decode("utf-8")
        except (UnicodeDecodeError, ValueError):
            return "bad_key", None
        # urllib deliberately preserves malformed percent escapes; reject them.
        index = 0
        while index < len(raw):
            if raw[index] == "%":
                if index + 2 >= len(raw) or any(char not in "0123456789abcdefABCDEF" for char in raw[index + 1:index + 3]):
                    return "bad_key", None
                index += 3
            else:
                index += 1
        if not key or "/" in key:
            return "bad_key", None
        return "kv", key

    def _read_json(self) -> Any:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            raise RequestError(400, "transfer encoding is not supported")
        length_text = self.headers.get("Content-Length")
        if length_text is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(length_text)
        except ValueError:
            raise RequestError(400, "invalid Content-Length") from None
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            return json.loads(body.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise RequestError(400, "malformed JSON") from None

    def do_GET(self) -> None:
        route, key = self._path()
        try:
            if route == "health":
                self._json(200, {"status": "ok"})
            elif route == "keys":
                self._json(200, {"keys": self.server.store.keys()})
            elif route == "kv":
                found, value = self.server.store.get(key or "")
                if found:
                    self._json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            elif route == "bad_key":
                self._error(400, "invalid key")
            else:
                self._error(404, "route not found")
        except OSError as error:
            self.log_error("storage error: %s", error)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        route, key = self._path()
        if route == "bad_key":
            self._error(400, "invalid key")
            return
        if route != "kv":
            self._error(404, "route not found")
            return
        try:
            document = self._read_json()
            if not isinstance(document, dict) or "value" not in document or not set(document) <= {"value", "ttl_seconds"}:
                raise RequestError(400, "body must contain value and optional ttl_seconds")
            ttl = document.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(400, "ttl_seconds must be finite and greater than zero")
            created = self.server.store.put(key or "", document["value"], ttl)
            self._json(201 if created else 200, {"key": key, "value": document["value"]})
        except RequestError as error:
            self._error(error.status, error.message)
        except (OSError, TypeError, ValueError) as error:
            self.log_error("storage error: %s", error)
            self._error(500, "storage error")

    def do_DELETE(self) -> None:
        route, key = self._path()
        try:
            if route == "bad_key":
                self._error(400, "invalid key")
            elif route != "kv":
                self._error(404, "route not found")
            elif self.server.store.delete(key or ""):
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self._error(404, "key not found")
        except OSError as error:
            self.log_error("storage error: %s", error)
            self._error(500, "storage error")

    def _unsupported(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        self.status = status
        self.message = message
        super().__init__(message)


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
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"startup error: {error}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(signum: int, frame: Any) -> None:
        del signum, frame
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
