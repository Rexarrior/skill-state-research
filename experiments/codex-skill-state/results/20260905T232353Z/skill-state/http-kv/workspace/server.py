#!/usr/bin/env python3
"""Persistent, dependency-free HTTP key-value service."""

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


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        self.status = status
        self.code = code
        self.message = message
        super().__init__(message)


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _expired(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is not None and expires_at <= now

    def _load(self) -> None:
        try:
            with self.path.open("r", encoding="utf-8") as source:
                raw = json.load(source)
        except FileNotFoundError:
            return
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc
        if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("entries"), dict):
            raise RuntimeError(f"invalid data file format: {self.path}")
        loaded: dict[str, dict[str, Any]] = {}
        for key, entry in raw["entries"].items():
            if not isinstance(key, str) or not isinstance(entry, dict) or "value" not in entry:
                raise RuntimeError(f"invalid data file format: {self.path}")
            expires_at = entry.get("expires_at")
            if expires_at is not None and (isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)) or not math.isfinite(expires_at)):
                raise RuntimeError(f"invalid data file format: {self.path}")
            loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        self.entries = loaded
        with self.lock:
            if self._purge_locked():
                self._persist_locked()

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if self._expired(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "entries": self.entries}
        temp_name: str | None = None
        try:
            fd, temp_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent)
            with os.fdopen(fd, "w", encoding="utf-8") as target:
                json.dump(payload, target, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                target.write("\n")
                target.flush()
                os.fsync(target.fileno())
            os.replace(temp_name, self.path)
            temp_name = None
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except FileNotFoundError:
                    pass

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked()
            created = key not in self.entries
            expires_at = None if ttl is None else time.time() + ttl
            self.entries[key] = {"value": value, "expires_at": expires_at}
            self._persist_locked()
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if self._expired(entry, time.time()):
                del self.entries[key]
                self._persist_locked()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked()
            if key not in self.entries:
                return False
            del self.entries[key]
            self._persist_locked()
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
        print(f"{self.client_address[0]} - {fmt % args}", file=sys.stderr)

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, error: ApiError) -> None:
        self._json(error.status, {"error": {"code": error.code, "message": error.message}})

    def _dispatch(self) -> None:
        try:
            self._route()
        except ApiError as exc:
            self._error(exc)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            self.log_error("unhandled request error", exc_info=True)
            self._error(ApiError(500, "internal_error", "internal server error"))

    def do_GET(self) -> None:
        self._dispatch()

    def do_PUT(self) -> None:
        self._dispatch()

    def do_DELETE(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_PATCH(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch()

    def do_OPTIONS(self) -> None:
        self._dispatch()

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _key(self, path: str) -> str:
        encoded = path[len(KV_PREFIX):]
        if not encoded or "/" in encoded:
            raise ApiError(400, "invalid_key", "key must be non-empty and cannot contain '/' ")
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ApiError(400, "invalid_key", "key must be valid UTF-8") from exc
        if not key or "/" in key:
            raise ApiError(400, "invalid_key", "key must be non-empty and cannot contain '/'")
        return key

    def _read_body(self) -> Any:
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            raise ApiError(411, "length_required", "Content-Length is required")
        try:
            length = int(content_length)
        except ValueError as exc:
            raise ApiError(400, "invalid_content_length", "invalid Content-Length") from exc
        if length < 0:
            raise ApiError(400, "invalid_content_length", "invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            raise ApiError(413, "body_too_large", "request body exceeds 1 MiB")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ApiError(400, "invalid_json", "request body must be valid JSON") from exc

    def _route(self) -> None:
        path = self._path()
        if path == "/health":
            if self.command != "GET":
                raise ApiError(405, "method_not_allowed", "method not allowed")
            self._json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            if self.command != "GET":
                raise ApiError(405, "method_not_allowed", "method not allowed")
            self._json(200, {"keys": self.server.store.keys()})
            return
        if path.startswith(KV_PREFIX):
            key = self._key(path)
            if self.command == "GET":
                found, value = self.server.store.get(key)
                if not found:
                    raise ApiError(404, "not_found", "key not found")
                self._json(200, {"key": key, "value": value})
                return
            if self.command == "PUT":
                body = self._read_body()
                if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                    raise ApiError(400, "invalid_body", "body must be an object with value and optional ttl_seconds")
                ttl = body.get("ttl_seconds")
                if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0):
                    raise ApiError(400, "invalid_ttl", "ttl_seconds must be finite and greater than zero")
                created = self.server.store.put(key, body["value"], None if ttl is None else float(ttl))
                self._json(201 if created else 200, {"key": key, "value": body["value"]})
                return
            if self.command == "DELETE":
                if not self.server.store.delete(key):
                    raise ApiError(404, "not_found", "key not found")
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            raise ApiError(405, "method_not_allowed", "method not allowed")
        raise ApiError(404, "not_found", "route not found")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
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

    def stop(_signum: int, _frame: Any) -> None:
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
