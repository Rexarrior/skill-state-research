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


MAX_BODY = 1024 * 1024
KV_PREFIX = "/v1/kv/"


class StoreError(Exception):
    pass


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

    def _purge_locked(self, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                raw = json.load(stream)
            if not isinstance(raw, dict) or raw.get("version") != 1:
                raise StoreError("unsupported data file format")
            entries = raw.get("entries")
            if not isinstance(entries, dict):
                raise StoreError("invalid data file entries")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise StoreError("invalid key in data file")
                if not isinstance(entry, dict) or "value" not in entry:
                    raise StoreError("invalid entry in data file")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise StoreError("invalid expiry in data file")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
            if self._purge_locked():
                self._persist_locked()
        except (OSError, UnicodeError, json.JSONDecodeError, StoreError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "entries": self.entries}
        temp_name: str | None = None
        try:
            fd, temp_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, self.path)
            temp_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except (OSError, ValueError) as exc:
            raise StoreError(f"cannot persist data: {exc}") from exc
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._purge_locked(now)
            created = key not in self.entries
            expires_at = None if ttl is None else now + ttl
            old = self.entries.get(key)
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                if old is None:
                    del self.entries[key]
                else:
                    self.entries[key] = old
                raise
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
            entry = self.entries.get(key)
            if entry is None:
                return False
            if not self._live(entry, time.time()):
                del self.entries[key]
                self._persist_locked()
                return False
            del self.entries[key]
            try:
                self._persist_locked()
            except StoreError:
                self.entries[key] = entry
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            changed = self._purge_locked()
            if changed:
                self._persist_locked()
            return sorted(self.entries)

    def flush(self) -> None:
        with self.lock:
            self._purge_locked()
            self._persist_locked()


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        super().__init__(address, Handler)
        self.store = store


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"
    sys_version = ""

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined,no-any-return]

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr, flush=True)

    def _json(self, status: int, body: Any) -> None:
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _route_path(self) -> str | None:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid request target")
            return None
        if parsed.query or parsed.fragment:
            self._error(HTTPStatus.NOT_FOUND, "unknown route")
            return None
        return parsed.path

    def _key(self, path: str) -> str | None:
        if not path.startswith(KV_PREFIX):
            return None
        encoded = path[len(KV_PREFIX):]
        if not encoded or "/" in encoded:
            return None
        try:
            raw = unquote_to_bytes(encoded)
            key = raw.decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError):
            return None
        if not key or "/" in key:
            return None
        return key

    def _read_json(self) -> Any:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            raise RequestError(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
        try:
            length = int(raw_length, 10)
        except ValueError as exc:
            raise RequestError(HTTPStatus.BAD_REQUEST, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RequestError(HTTPStatus.BAD_REQUEST, "malformed JSON") from exc

    def _run(self, action: Any) -> None:
        try:
            action()
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except StoreError as exc:
            print(str(exc), file=sys.stderr, flush=True)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "persistence failure")
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self) -> None:
        self._run(self._do_get)

    def _do_get(self) -> None:
        path = self._route_path()
        if path is None:
            return
        if path == "/health":
            self._json(HTTPStatus.OK, {"status": "ok"})
        elif path == "/v1/keys":
            self._json(HTTPStatus.OK, {"keys": self.store.keys()})
        elif path.startswith(KV_PREFIX):
            key = self._key(path)
            if key is None:
                self._error(HTTPStatus.BAD_REQUEST, "invalid key")
                return
            found, value = self.store.get(key)
            if found:
                self._json(HTTPStatus.OK, {"key": key, "value": value})
            else:
                self._error(HTTPStatus.NOT_FOUND, "key not found")
        else:
            self._error(HTTPStatus.NOT_FOUND, "unknown route")

    def do_PUT(self) -> None:
        self._run(self._do_put)

    def _do_put(self) -> None:
        path = self._route_path()
        if path is None:
            return
        key = self._key(path)
        if key is None:
            if path.startswith(KV_PREFIX):
                raise RequestError(HTTPStatus.BAD_REQUEST, "invalid key")
            raise RequestError(HTTPStatus.NOT_FOUND, "unknown route")
        body = self._read_json()
        if not isinstance(body, dict) or "value" not in body or any(k not in {"value", "ttl_seconds"} for k in body):
            raise RequestError(HTTPStatus.BAD_REQUEST, "body must be an object with value and optional ttl_seconds")
        ttl = body.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            raise RequestError(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
        created = self.store.put(key, body["value"], None if ttl is None else float(ttl))
        self._json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": body["value"]})

    def do_DELETE(self) -> None:
        self._run(self._do_delete)

    def _do_delete(self) -> None:
        path = self._route_path()
        if path is None:
            return
        key = self._key(path)
        if key is None:
            if path.startswith(KV_PREFIX):
                raise RequestError(HTTPStatus.BAD_REQUEST, "invalid key")
            raise RequestError(HTTPStatus.NOT_FOUND, "unknown route")
        if not self.store.delete(key):
            raise RequestError(HTTPStatus.NOT_FOUND, "key not found")
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unsupported(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported
    do_HEAD = _unsupported


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
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
    except (OSError, StoreError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr)
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
        try:
            store.flush()
        except StoreError as exc:
            print(f"shutdown persistence failed: {exc}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
