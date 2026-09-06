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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as source:
            document = json.load(source, parse_constant=self._reject_constant)
        if not isinstance(document, dict) or set(document) != {"entries"}:
            raise ValueError("invalid data file format")
        raw_entries = document["entries"]
        if not isinstance(raw_entries, dict):
            raise ValueError("invalid data file entries")
        loaded: dict[str, dict[str, Any]] = {}
        for key, entry in raw_entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise ValueError("invalid key in data file")
            if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                raise ValueError("invalid entry in data file")
            expiry = entry["expires_at"]
            if expiry is not None and (
                isinstance(expiry, bool)
                or not isinstance(expiry, (int, float))
                or not math.isfinite(expiry)
            ):
                raise ValueError("invalid expiry in data file")
            loaded[key] = {"value": entry["value"], "expires_at": expiry}
        self.entries = loaded
        if self._remove_expired_locked():
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    def _remove_expired_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
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
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
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

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._remove_expired_locked()
            created = key not in self.entries
            expiry = None if ttl is None else time.time() + ttl
            self.entries[key] = {"value": value, "expires_at": expiry}
            self._persist_locked()
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if not self._live(entry, time.time()):
                del self.entries[key]
                self._persist_locked()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            changed = self._remove_expired_locked()
            present = key in self.entries
            if present:
                del self.entries[key]
            if changed or present:
                self._persist_locked()
            return present

    def keys(self) -> list[str]:
        with self.lock:
            if self._remove_expired_locked():
                self._persist_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))

    def _send_json(self, status: int, payload: Any, *, extra_headers: dict[str, str] | None = None) -> None:
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

    def _error(self, status: int, message: str, *, headers: dict[str, str] | None = None) -> None:
        self._send_json(status, {"error": message}, extra_headers=headers)

    def _path(self) -> str:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            raise RequestError(404, "unknown route")
        return parsed.path

    def _key(self, path: str) -> str:
        if not path.startswith(KEY_PREFIX):
            raise RequestError(404, "unknown route")
        encoded = path[len(KEY_PREFIX):]
        if not encoded or "/" in encoded or BAD_ESCAPE.search(encoded):
            raise RequestError(400, "invalid key")
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RequestError(400, "invalid key") from exc
        if not key or "/" in key:
            raise RequestError(400, "invalid key")
        return key

    def _read_object(self) -> dict[str, Any]:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            raise RequestError(400, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise RequestError(400, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            # Drain the declared body before replying. Closing a socket with
            # unread request bytes can surface as a reset instead of JSON 413.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise RequestError(413, "request body exceeds 1 MiB")
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise RequestError(400, "malformed JSON") from exc
        if not isinstance(value, dict):
            raise RequestError(400, "request body must be a JSON object")
        return value

    def do_GET(self) -> None:
        try:
            path = self._path()
            if path == "/health":
                self._send_json(200, {"status": "ok"})
            elif path == "/v1/keys":
                self._send_json(200, {"keys": self.server.store.keys()})
            else:
                key = self._key(path)
                found, value = self.server.store.get(key)
                if not found:
                    self._error(404, "key not found")
                else:
                    self._send_json(200, {"key": key, "value": value})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except (OSError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._error(500, "internal server error")

    def do_PUT(self) -> None:
        try:
            key = self._key(self._path())
            body = self._read_object()
            if "value" not in body or not set(body).issubset({"value", "ttl_seconds"}):
                raise RequestError(400, "body must contain value and optional ttl_seconds")
            ttl = body.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(400, "ttl_seconds must be a finite number greater than zero")
            created = self.server.store.put(key, body["value"], ttl)
            self._send_json(201 if created else 200, {"key": key, "value": body["value"]})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except (OSError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._error(500, "internal server error")

    def do_DELETE(self) -> None:
        try:
            key = self._key(self._path())
            if not self.server.store.delete(key):
                self._error(404, "key not found")
                return
            self.send_response(204)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except (OSError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._error(500, "internal server error")

    def _method_not_allowed(self) -> None:
        self._error(405, "method not allowed", headers={"Allow": "GET, PUT, DELETE"})

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed


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
        server = Server((args.host, args.port), store)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr)
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
