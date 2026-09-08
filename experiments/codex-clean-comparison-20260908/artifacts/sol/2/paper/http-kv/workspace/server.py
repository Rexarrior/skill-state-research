#!/usr/bin/env python3
"""Persistent, dependency-free HTTP key-value service."""

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


MAX_BODY_BYTES = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
HEX_ESCAPE = re.compile(r"%[0-9A-Fa-f]{2}")


class BadRequest(Exception):
    """An error that should be returned to the HTTP client."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _strict_json_loads(data: bytes) -> Any:
    def reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    try:
        return json.loads(data.decode("utf-8"), parse_constant=reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise BadRequest(400, "invalid_json", "request body must be valid JSON") from exc


def _decode_key(encoded: str) -> str:
    # urllib deliberately leaves malformed percent escapes untouched, so check them.
    index = 0
    while index < len(encoded):
        if encoded[index] == "%":
            match = HEX_ESCAPE.match(encoded, index)
            if match is None:
                raise BadRequest(400, "invalid_key", "key has invalid URL encoding")
            index += 3
        else:
            index += 1
    try:
        key = unquote_to_bytes(encoded).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise BadRequest(400, "invalid_key", "key must decode as UTF-8") from exc
    if not key or "/" in key:
        raise BadRequest(400, "invalid_key", "key must be non-empty and cannot contain '/'")
    return key


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("invalid persistence document")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key or not isinstance(entry, dict):
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
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
        except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        if self._purge_expired_locked():
            self._persist_locked()

    def _purge_expired_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if not self._is_live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.path.parent,
                prefix=f".{self.path.name}.", suffix=".tmp", delete=False,
            ) as handle:
                temporary_name = handle.name
                json.dump({"entries": self.entries}, handle, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":"), sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = None
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some platforms/filesystems do not support syncing directories.
                pass
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass

    def put(self, key: str, value: Any, ttl_seconds: float | int | None) -> bool:
        with self.lock:
            self._purge_expired_locked()
            created = key not in self.entries
            previous = self.entries.get(key)
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except Exception:
                if previous is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if not self._is_live(entry, time.time()):
                del self.entries[key]
                self._persist_locked()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False
            if not self._is_live(entry, time.time()):
                del self.entries[key]
                self._persist_locked()
                return False
            del self.entries[key]
            try:
                self._persist_locked()
            except Exception:
                self.entries[key] = entry
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_expired_locked():
                self._persist_locked()
            return sorted(self.entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        super().__init__(address, RequestHandler)
        self.store = store


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, document: Any) -> None:
        body = json.dumps(document, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, code: str, message: str) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}})

    def _path(self) -> str:
        try:
            parsed = urlsplit(self.path)
        except ValueError as exc:
            raise BadRequest(400, "invalid_path", "invalid request path") from exc
        if parsed.query or parsed.fragment:
            raise BadRequest(404, "not_found", "route not found")
        return parsed.path

    def _route_key(self, path: str) -> str | None:
        if not path.startswith(KEY_PREFIX):
            return None
        return _decode_key(path[len(KEY_PREFIX):])

    def _read_json_body(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            raise BadRequest(400, "invalid_body", "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise BadRequest(411, "length_required", "Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise BadRequest(400, "invalid_body", "invalid Content-Length") from exc
        if length < 0:
            raise BadRequest(400, "invalid_body", "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            raise BadRequest(413, "body_too_large", "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            raise BadRequest(400, "invalid_body", "incomplete request body")
        return _strict_json_loads(body)

    def _dispatch(self, method: str) -> None:
        path = self._path()
        key = self._route_key(path)

        if method == "GET" and path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        if method == "GET" and path == "/v1/keys":
            self._send_json(200, {"keys": self.server.store.keys()})
            return
        if key is not None:
            if method == "PUT":
                document = self._read_json_body()
                if not isinstance(document, dict) or "value" not in document:
                    raise BadRequest(400, "invalid_body", "body must be an object containing 'value'")
                if not set(document).issubset({"value", "ttl_seconds"}):
                    raise BadRequest(400, "invalid_body", "body contains unsupported fields")
                ttl = document.get("ttl_seconds")
                if ttl is not None and (
                    isinstance(ttl, bool)
                    or not isinstance(ttl, (int, float))
                    or not math.isfinite(ttl)
                    or ttl <= 0
                ):
                    raise BadRequest(400, "invalid_ttl", "ttl_seconds must be finite and greater than zero")
                created = self.server.store.put(key, document["value"], ttl)
                self._send_json(201 if created else 200, {"key": key, "value": document["value"]})
                return
            if method == "GET":
                found, value = self.server.store.get(key)
                if not found:
                    raise BadRequest(404, "not_found", "key not found")
                self._send_json(200, {"key": key, "value": value})
                return
            if method == "DELETE":
                if not self.server.store.delete(key):
                    raise BadRequest(404, "not_found", "key not found")
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            raise BadRequest(405, "method_not_allowed", "method not allowed for this route")

        known_path = path in {"/health", "/v1/keys"}
        if known_path:
            raise BadRequest(405, "method_not_allowed", "method not allowed for this route")
        raise BadRequest(404, "not_found", "route not found")

    def _handle(self, method: str) -> None:
        try:
            self._dispatch(method)
        except BadRequest as exc:
            self._error(exc.status, exc.code, exc.message)
        except (OSError, TypeError, ValueError) as exc:
            print(f"request failed: {exc}", file=sys.stderr, flush=True)
            self._error(500, "internal_error", "internal server error")

    def do_GET(self) -> None:
        self._handle("GET")

    def do_PUT(self) -> None:
        self._handle("PUT")

    def do_DELETE(self) -> None:
        self._handle("DELETE")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_PATCH(self) -> None:
        self._handle("PATCH")

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}", file=sys.stderr, flush=True)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True, type=Path)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = _parse_args()
    try:
        store = Store(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            # shutdown() must run outside the serve_forever thread.
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
