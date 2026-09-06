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
JSON_TYPE = "application/json"


class Store:
    def __init__(self, path: Path) -> None:
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
            with self.path.open("r", encoding="utf-8") as stream:
                raw = json.load(stream)
            if not isinstance(raw, dict) or raw.get("version") != 1:
                raise ValueError("unsupported data-file format")
            entries = raw.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("invalid entries in data file")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError("invalid entry in data file")
                if "value" not in entry:
                    raise ValueError("entry has no value")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    not isinstance(expires_at, (int, float))
                    or isinstance(expires_at, bool)
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiry in data file")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        now = time.time()
        self.entries = {k: v for k, v in loaded.items() if self._live(v, now)}
        if len(self.entries) != len(loaded):
            self._persist_locked()

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "entries": self.entries}
        fd, temporary = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
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
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            purged = self._purge_locked()
            created = key not in self.entries
            expires_at = None if ttl is None else time.time() + ttl
            previous = self.entries.get(key)
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

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            if self._purge_locked():
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            purged = self._purge_locked()
            previous = self.entries.pop(key, None)
            if previous is None:
                if purged:
                    self._persist_locked()
                return False
            try:
                self._persist_locked()
            except BaseException:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_locked():
                self._persist_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _send(self, status: int, payload: Any | None = None) -> None:
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        if payload is not None:
            self.send_header("Content-Type", JSON_TYPE)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send(status, {"error": message})

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _key(self) -> tuple[str | None, str | None]:
        path = self._path()
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None, None
        encoded = path[len(prefix):]
        if not encoded or "/" in encoded:
            return None, "invalid key"
        hexdigits = frozenset("0123456789abcdefABCDEF")
        for index, character in enumerate(encoded):
            if character == "%" and (
                index + 2 >= len(encoded)
                or encoded[index + 1] not in hexdigits
                or encoded[index + 2] not in hexdigits
            ):
                return None, "invalid URL encoding in key"
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            return None, "key must be valid UTF-8"
        if not key or "/" in key:
            return None, "invalid key"
        return key, None

    def _read_json(self) -> tuple[Any | None, str | None, int]:
        length_text = self.headers.get("Content-Length")
        if length_text is None:
            return None, "Content-Length is required", 411
        try:
            length = int(length_text)
        except ValueError:
            return None, "invalid Content-Length", 400
        if length < 0:
            return None, "invalid Content-Length", 400
        if length > MAX_BODY:
            # A client may still be transmitting the request while we parse its
            # headers.  Closing immediately can reset the connection before it
            # receives the 413 response, so consume this request body first.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            return None, "request body exceeds 1 MiB", 413
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                return None, "incomplete request body", 400
            return json.loads(
                body,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError(f"invalid JSON constant: {value}")
                ),
            ), None, 0
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            return None, "malformed JSON", 400

    def do_GET(self) -> None:
        path = self._path()
        try:
            if path == "/health":
                self._send(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._send(200, {"keys": self.server.store.keys()})
                return
            key, error = self._key()
            if error:
                self._error(400, error)
                return
            if key is not None:
                found, value = self.server.store.get(key)
                if found:
                    self._send(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
                return
            self._error(404, "route not found")
        except OSError as exc:
            self.log_error("storage failure: %s", exc)
            self._error(500, "storage failure")

    def do_PUT(self) -> None:
        key, error = self._key()
        if key is None:
            self._error(400 if error else 404, error or "route not found")
            return
        payload, error, status = self._read_json()
        if error:
            self._error(status, error)
            return
        if not isinstance(payload, dict) or "value" not in payload:
            self._error(400, "body must be an object containing value")
            return
        if set(payload) - {"value", "ttl_seconds"}:
            self._error(400, "body contains unsupported fields")
            return
        ttl = payload.get("ttl_seconds")
        if "ttl_seconds" in payload:
            if (
                not isinstance(ttl, (int, float))
                or isinstance(ttl, bool)
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                self._error(400, "ttl_seconds must be finite and greater than zero")
                return
        try:
            created = self.server.store.put(key, payload["value"], ttl)
            self._send(201 if created else 200, {"key": key, "value": payload["value"]})
        except (OSError, ValueError) as exc:
            self.log_error("storage failure: %s", exc)
            self._error(500, "storage failure")

    def do_DELETE(self) -> None:
        key, error = self._key()
        if key is None:
            self._error(400 if error else 404, error or "route not found")
            return
        try:
            if self.server.store.delete(key):
                self._send(204)
            else:
                self._error(404, "key not found")
        except OSError as exc:
            self.log_error("storage failure: %s", exc)
            self._error(500, "storage failure")

    def _unsupported_method(self) -> None:
        self.close_connection = True
        self._error(405, "method not allowed")

    do_POST = _unsupported_method
    do_PATCH = _unsupported_method
    do_OPTIONS = _unsupported_method
    do_HEAD = _unsupported_method
    do_CONNECT = _unsupported_method
    do_TRACE = _unsupported_method

    def _unsupported(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported
    do_HEAD = _unsupported


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
    except (OSError, RuntimeError) as exc:
        print(f"startup error: {exc}", file=sys.stderr)
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
