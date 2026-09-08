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
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class Entry:
    value: Any
    expires_at: float | None


class Store:
    """Thread-safe in-memory state backed by an atomically replaced JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, Entry] = {}
        self._load()

    @staticmethod
    def _is_expired(entry: Entry, now: float) -> bool:
        return entry.expires_at is not None and entry.expires_at <= now

    def _live_entries(self, now: float) -> dict[str, Entry]:
        return {
            key: entry
            for key, entry in self._entries.items()
            if not self._is_expired(entry, now)
        }

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
            for key, raw_entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("data file contains an invalid key")
                try:
                    key.encode("utf-8")
                except UnicodeEncodeError as exc:
                    raise ValueError("data file contains a non-UTF-8 key") from exc
                if not isinstance(raw_entry, dict) or set(raw_entry) != {
                    "value",
                    "expires_at",
                }:
                    raise ValueError("data file contains an invalid entry")
                expires_at = raw_entry["expires_at"]
                if expires_at is not None and not self._finite_number(expires_at):
                    raise ValueError("data file contains an invalid expiry")
                loaded[key] = Entry(raw_entry["value"], expires_at)
        except (OSError, ValueError, TypeError, json.JSONDecodeError, RecursionError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        now = time.time()
        self._entries = self._filter_entries(loaded, now)
        if len(self._entries) != len(loaded):
            self._persist(self._entries)

    @staticmethod
    def _reject_constant(token: str) -> None:
        raise ValueError(f"invalid JSON number {token}")

    @staticmethod
    def _finite_number(value: Any) -> bool:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        try:
            return math.isfinite(value)
        except OverflowError:
            return False

    @staticmethod
    def _filter_entries(entries: dict[str, Entry], now: float) -> dict[str, Entry]:
        return {
            key: entry
            for key, entry in entries.items()
            if entry.expires_at is None or entry.expires_at > now
        }

    def _persist(self, entries: dict[str, Entry]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        document = {
            "version": 1,
            "entries": {
                key: {"value": entry.value, "expires_at": entry.expires_at}
                for key, entry in entries.items()
            },
        }
        temporary_name: str | None = None
        try:
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
            )
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(
                    document,
                    output,
                    ensure_ascii=True,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = None
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Directory fsync is unavailable on some platforms/filesystems.
                pass
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass

    def _remove_expired_locked(self, now: float) -> None:
        live = self._live_entries(now)
        if len(live) != len(self._entries):
            self._persist(live)
            self._entries = live

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self._lock:
            now = time.time()
            live = self._live_entries(now)
            created = key not in live
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            updated = dict(live)
            updated[key] = Entry(value, expires_at)
            self._persist(updated)
            self._entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            self._remove_expired_locked(time.time())
            entry = self._entries.get(key)
            return (False, None) if entry is None else (True, entry.value)

    def delete(self, key: str) -> bool:
        with self._lock:
            now = time.time()
            live = self._live_entries(now)
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
            self._remove_expired_locked(time.time())
            return sorted(self._entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
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

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        del explain
        phrase = HTTPStatus(code).phrase if code in HTTPStatus._value2member_map_ else "Error"
        self._send_json(code, {"error": message or phrase})

    def _send_json(self, status: int, body: Any | None = None) -> None:
        payload = b"" if body is None else json.dumps(
            body, ensure_ascii=True, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if payload and self.command != "HEAD":
            self.wfile.write(payload)

    def _declared_length(self, required: bool = False) -> int:
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(400, "transfer encoding is not supported")
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths:
            if required:
                raise RequestError(411, "Content-Length is required")
            return 0
        if len(lengths) != 1:
            raise RequestError(400, "invalid Content-Length")
        try:
            length = int(lengths[0], 10)
        except ValueError as exc:
            raise RequestError(400, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        return length

    def _read_json(self) -> Any:
        length = self._declared_length(required=True)
        raw = self.rfile.read(length)
        try:
            return json.loads(
                raw.decode("utf-8"), parse_constant=Store._reject_constant
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError, RecursionError) as exc:
            raise RequestError(400, "malformed JSON") from exc

    def _path(self) -> str:
        try:
            return urlsplit(self.path).path
        except ValueError as exc:
            raise RequestError(400, "invalid request target") from exc

    def _key(self) -> str:
        path = self._path()
        if not path.startswith(KEY_PREFIX):
            raise RequestError(404, "route not found")
        encoded = path[len(KEY_PREFIX) :]
        if BAD_PERCENT_ESCAPE.search(encoded):
            raise RequestError(400, "invalid key encoding")
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RequestError(400, "key must be UTF-8") from exc
        if not key or "/" in key:
            raise RequestError(400, "key must be non-empty and may not contain '/'")
        return key

    def _run(self, action: Any) -> None:
        try:
            action()
        except RequestError as exc:
            self._send_json(exc.status, {"error": exc.message})
        except OSError as exc:
            self.log_error("persistence operation failed: %s", exc)
            self._send_json(500, {"error": "persistence operation failed"})

    def do_GET(self) -> None:
        self._run(self._do_GET)

    def _do_GET(self) -> None:
        self._declared_length()
        path = self._path()
        if path == "/health":
            self._send_json(200, {"status": "ok"})
        elif path == "/v1/keys":
            self._send_json(200, {"keys": self.server.store.keys()})
        elif path.startswith(KEY_PREFIX):
            key = self._key()
            found, value = self.server.store.get(key)
            if found:
                self._send_json(200, {"key": key, "value": value})
            else:
                self._send_json(404, {"error": "key not found"})
        else:
            raise RequestError(404, "route not found")

    def do_PUT(self) -> None:
        self._run(self._do_PUT)

    def _do_PUT(self) -> None:
        key = self._key()
        body = self._read_json()
        if not isinstance(body, dict) or "value" not in body:
            raise RequestError(400, "body must be an object containing 'value'")
        if not set(body).issubset({"value", "ttl_seconds"}):
            raise RequestError(400, "body contains unsupported fields")
        ttl = body.get("ttl_seconds")
        if "ttl_seconds" in body and (
            not Store._finite_number(ttl) or ttl <= 0
        ):
            raise RequestError(400, "ttl_seconds must be finite and greater than zero")
        created = self.server.store.put(key, body["value"], ttl)
        self._send_json(201 if created else 200, {"key": key, "value": body["value"]})

    def do_DELETE(self) -> None:
        self._run(self._do_DELETE)

    def _do_DELETE(self) -> None:
        self._declared_length()
        key = self._key()
        if self.server.store.delete(key):
            self._send_json(204)
        else:
            self._send_json(404, {"error": "key not found"})

    def _unsupported(self) -> None:
        self._run(lambda: self._reject_method())

    def _reject_method(self) -> None:
        self._declared_length()
        self.send_response(405)
        payload = b'{"error":"method not allowed"}'
        self.send_header("Allow", "GET, PUT, DELETE")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
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
    except (OSError, RuntimeError) as exc:
        print(f"server startup failed: {exc}", file=sys.stderr)
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
