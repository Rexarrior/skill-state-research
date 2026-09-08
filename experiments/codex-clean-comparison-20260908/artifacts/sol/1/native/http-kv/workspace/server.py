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


MAX_BODY = 1024 * 1024
_BAD_PERCENT = re.compile(r"%(?![0-9A-Fa-f]{2})")


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _finite_json(value: Any) -> bool:
    """Return whether a decoded value can be emitted as standards-compliant JSON."""
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_finite_json(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _finite_json(item) for key, item in value.items())
    return value is None or isinstance(value, (str, int, bool))


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._invalid_constant)
            raw_entries = document["entries"]
            if set(document) != {"version", "entries"} or document["version"] != 1:
                raise ValueError("unsupported persistence format")
            if not isinstance(raw_entries, dict):
                raise ValueError("entries must be an object")
            now = time.time()
            removed_expired = False
            for key, entry in raw_entries.items():
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
                if not _finite_json(entry["value"]):
                    raise ValueError("invalid stored JSON value")
                if expires_at is not None and expires_at <= now:
                    removed_expired = True
                    continue
                self.entries[key] = {"value": entry["value"], "expires_at": expires_at}
            if removed_expired:
                self._persist_locked()
        except (OSError, json.JSONDecodeError, KeyError, OverflowError, TypeError, ValueError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _invalid_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist_locked(self) -> None:
        document = {"version": 1, "entries": self.entries}
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    document,
                    handle,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            # Make the directory entry durable where directory fsync is supported.
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
            except FileNotFoundError:
                pass
            raise

    @staticmethod
    def _live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is None or expires_at > now

    def _discard_expired_locked(self, key: str, now: float) -> bool:
        entry = self.entries.get(key)
        if entry is None or self._live(entry, now):
            return False
        del self.entries[key]
        try:
            self._persist_locked()
        except OSError as exc:
            print(f"warning: could not persist expiration cleanup: {exc}", file=sys.stderr)
        return True

    def put(self, key: str, value: Any, ttl: float | int | None) -> bool:
        with self.lock:
            now = time.time()
            self._discard_expired_locked(key, now)
            existed = key in self.entries
            previous = self.entries.get(key)
            try:
                expires_at = None if ttl is None else now + ttl
            except OverflowError as exc:
                raise RequestError(400, "ttl_seconds is too large") from exc
            if expires_at is not None and not math.isfinite(expires_at):
                raise RequestError(400, "ttl_seconds is too large")
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except OSError:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return existed

    def get(self, key: str) -> Any:
        with self.lock:
            self._discard_expired_locked(key, time.time())
            entry = self.entries.get(key)
            if entry is None:
                raise KeyError(key)
            return entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            self._discard_expired_locked(key, time.time())
            previous = self.entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist_locked()
            except OSError:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            now = time.time()
            expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
            if expired:
                for key in expired:
                    del self.entries[key]
                try:
                    self._persist_locked()
                except OSError as exc:
                    print(f"warning: could not persist expiration cleanup: {exc}", file=sys.stderr)
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

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _send_json(self, status: int, payload: Any | None = None) -> None:
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        # BaseHTTPRequestHandler otherwise emits HTML for malformed requests and
        # unknown method tokens.
        if code == 501:
            code, message = 405, "method not allowed"
        self._error(code, message or self.responses.get(code, ("error",))[0].lower())

    def _path(self) -> str:
        try:
            split = urlsplit(self.path)
        except ValueError as exc:
            raise RequestError(400, "invalid request target") from exc
        if split.query or split.fragment:
            raise RequestError(404, "route not found")
        return split.path

    def _key(self, path: str) -> str:
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            raise RequestError(404, "route not found")
        encoded = path[len(prefix):]
        if not encoded:
            raise RequestError(400, "key must not be empty")
        if _BAD_PERCENT.search(encoded):
            raise RequestError(400, "key has invalid percent encoding")
        try:
            raw = encoded.encode("ascii")
            key = unquote_to_bytes(raw).decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError) as exc:
            raise RequestError(400, "key must be valid URL-encoded UTF-8") from exc
        if not key:
            raise RequestError(400, "key must not be empty")
        if "/" in key:
            raise RequestError(400, "key must not contain slash")
        return key

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            raise RequestError(400, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self.close_connection = True
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(raw_length, 10)
        except ValueError as exc:
            self.close_connection = True
            raise RequestError(400, "invalid Content-Length") from exc
        if length < 0:
            self.close_connection = True
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            raise RequestError(400, "incomplete request body")
        try:
            result = json.loads(body.decode("utf-8"), parse_constant=Store._invalid_constant)
            finite = _finite_json(result)
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
            raise RequestError(400, "malformed JSON") from exc
        if not finite:
            raise RequestError(400, "JSON numbers must be finite")
        return result

    def do_GET(self) -> None:
        try:
            path = self._path()
            if path == "/health":
                self._send_json(200, {"status": "ok"})
            elif path == "/v1/keys":
                self._send_json(200, {"keys": self.server.store.keys()})
            elif path.startswith("/v1/kv/"):
                key = self._key(path)
                try:
                    value = self.server.store.get(key)
                except KeyError:
                    self._error(404, "key not found")
                else:
                    self._send_json(200, {"key": key, "value": value})
            else:
                self._error(404, "route not found")
        except RequestError as exc:
            self._error(exc.status, exc.message)

    def do_PUT(self) -> None:
        try:
            key = self._key(self._path())
            document = self._read_json()
            if not isinstance(document, dict):
                raise RequestError(400, "request body must be a JSON object")
            if "value" not in document or not set(document).issubset({"value", "ttl_seconds"}):
                raise RequestError(400, "body must contain value and optional ttl_seconds only")
            ttl = document.get("ttl_seconds")
            if "ttl_seconds" in document:
                valid_ttl = not isinstance(ttl, bool) and isinstance(ttl, (int, float)) and ttl > 0
                if valid_ttl and isinstance(ttl, float):
                    valid_ttl = math.isfinite(ttl)
                if not valid_ttl:
                    raise RequestError(400, "ttl_seconds must be a finite number greater than zero")
            replaced = self.server.store.put(key, document["value"], ttl)
            self._send_json(200 if replaced else 201, {"key": key, "value": document["value"]})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except OSError as exc:
            self.log_error("persistence failure: %s", exc)
            self._error(500, "could not persist data")

    def do_DELETE(self) -> None:
        try:
            key = self._key(self._path())
            if self.server.store.delete(key):
                self._send_json(204)
            else:
                self._error(404, "key not found")
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except OSError as exc:
            self.log_error("persistence failure: %s", exc)
            self._error(500, "could not persist data")

    def _method_not_allowed(self) -> None:
        self.close_connection = True
        self._error(405, "method not allowed")

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_CONNECT = _method_not_allowed
    do_TRACE = _method_not_allowed


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
        print(f"startup error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(signum: int, frame: Any) -> None:
        del signum, frame
        if not stopping.is_set():
            stopping.set()
            # shutdown() must run outside the serve_forever() thread.
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
