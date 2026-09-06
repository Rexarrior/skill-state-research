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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=_reject_constant)
            raw_entries = document.get("entries")
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("expected an object containing an entries object")
            now = time.time()
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError("invalid persisted entry")
                if set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid persisted entry fields")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid persisted expiration")
                if expires_at is None or expires_at > now:
                    self.entries[key] = entry
            if len(self.entries) != len(raw_entries):
                self._persist_locked()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [
            key
            for key, entry in self.entries.items()
            if entry["expires_at"] is not None and entry["expires_at"] <= now
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    {"entries": self.entries},
                    handle,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
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
                # Directory fsync is not supported on every platform/filesystem.
                pass
        except BaseException:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
            raise

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self.lock:
            self._purge_locked()
            created = key not in self.entries
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            self.entries[key] = {"value": value, "expires_at": expires_at}
            self._persist_locked()
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            if self._purge_locked():
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            changed = self._purge_locked()
            present = key in self.entries
            if present:
                del self.entries[key]
                changed = True
            if changed:
                self._persist_locked()
            return present

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_locked():
                self._persist_locked()
            return sorted(self.entries)

    def purge_and_persist(self) -> None:
        with self.lock:
            if self._purge_locked():
                self._persist_locked()


def _reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def _decode_key(path: str) -> str:
    if not path.startswith(KEY_PREFIX):
        raise ValueError("unknown route")
    encoded = path[len(KEY_PREFIX) :]
    if not encoded or "/" in encoded:
        raise ValueError("key must be non-empty and must not contain '/'")
    index = 0
    while index < len(encoded):
        if encoded[index] == "%":
            if index + 2 >= len(encoded) or any(
                char not in "0123456789abcdefABCDEF" for char in encoded[index + 1 : index + 3]
            ):
                raise ValueError("key contains invalid percent-encoding")
            index += 3
        else:
            index += 1
    try:
        key = unquote_to_bytes(encoded).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("key is not valid UTF-8") from exc
    if not key or "/" in key:
        raise ValueError("key must be non-empty and must not contain '/'")
    return key


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined,no-any-return]

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _route_path(self) -> str | None:
        try:
            return urlsplit(self.path).path
        except ValueError:
            self._error(400, "invalid request target")
            return None

    def _key(self, path: str) -> str | None:
        try:
            return _decode_key(path)
        except ValueError as exc:
            self._error(400, str(exc))
            return None

    def _read_json(self) -> Any:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(length_header, 10)
        except ValueError as exc:
            raise RequestError(400, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise RequestError(400, "incomplete request body")
        try:
            return json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise RequestError(400, "malformed JSON") from exc

    def do_GET(self) -> None:
        path = self._route_path()
        if path is None:
            return
        try:
            if path == "/health":
                self._json(200, {"status": "ok"})
            elif path == "/v1/keys":
                self._json(200, {"keys": self.store.keys()})
            elif path.startswith(KEY_PREFIX):
                key = self._key(path)
                if key is None:
                    return
                found, value = self.store.get(key)
                if found:
                    self._json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            else:
                self._error(404, "route not found")
        except OSError as exc:
            self.log_error("persistence error: %s", exc)
            self._error(500, "persistence error")

    def do_PUT(self) -> None:
        path = self._route_path()
        if path is None:
            return
        if not path.startswith(KEY_PREFIX):
            self._error(404, "route not found")
            return
        key = self._key(path)
        if key is None:
            return
        try:
            body = self._read_json()
            if not isinstance(body, dict):
                raise RequestError(400, "body must be a JSON object")
            if "value" not in body or not set(body).issubset({"value", "ttl_seconds"}):
                raise RequestError(400, "body must contain value and optional ttl_seconds")
            ttl = body.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(400, "ttl_seconds must be finite and greater than zero")
            created = self.store.put(key, body["value"], ttl)
            self._json(201 if created else 200, {"key": key, "value": body["value"]})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except OSError as exc:
            self.log_error("persistence error: %s", exc)
            self._error(500, "persistence error")

    def do_DELETE(self) -> None:
        path = self._route_path()
        if path is None:
            return
        if not path.startswith(KEY_PREFIX):
            self._error(404, "route not found")
            return
        key = self._key(path)
        if key is None:
            return
        try:
            if self.store.delete(key):
                self._empty(204)
            else:
                self._error(404, "key not found")
        except OSError as exc:
            self.log_error("persistence error: %s", exc)
            self._error(500, "persistence error")

    def _unsupported(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(
            "%s - - [%s] %s\n"
            % (self.client_address[0], self.log_date_time_string(), format % args)
        )


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


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
    exit_code = 0
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        try:
            store.purge_and_persist()
        except OSError as exc:
            print(f"shutdown persistence error: {exc}", file=sys.stderr)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
