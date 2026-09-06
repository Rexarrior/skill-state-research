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
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_SIZE = 1024 * 1024


class StoreError(RuntimeError):
    pass


class PersistentStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._load()

    @staticmethod
    def _is_live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or set(document) != {"entries"}:
                raise ValueError("top level must contain exactly 'entries'")
            entries = document["entries"]
            if not isinstance(entries, dict):
                raise ValueError("'entries' must be an object")
            validated: dict[str, dict[str, Any]] = {}
            for key, entry in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("stored key is invalid")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("stored entry is invalid")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("stored expiration is invalid")
                validated[key] = entry
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

        now = time.time()
        self._entries = {
            key: entry for key, entry in validated.items() if self._is_live(entry, now)
        }
        if len(self._entries) != len(validated):
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist_locked(self) -> None:
        temporary_name: str | None = None
        try:
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
            )
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    {"entries": self._entries},
                    handle,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
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
                # Some platforms/filesystems do not support fsync on directories.
                pass
        except (OSError, ValueError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass

    def _purge_expired_locked(self) -> bool:
        now = time.time()
        expired = [
            key for key, entry in self._entries.items() if not self._is_live(entry, now)
        ]
        if not expired:
            return False
        for key in expired:
            del self._entries[key]
        self._persist_locked()
        return True

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self._lock:
            self._purge_expired_locked()
            created = key not in self._entries
            expires_at = time.time() + ttl_seconds if ttl_seconds is not None else None
            previous = self._entries.get(key)
            self._entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                if previous is None:
                    del self._entries[key]
                else:
                    self._entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            self._purge_expired_locked()
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            self._purge_expired_locked()
            previous = self._entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist_locked()
            except StoreError:
                self._entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            self._purge_expired_locked()
            return sorted(self._entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: PersistentStore) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"
    sys_version = ""

    @property
    def kv_server(self) -> KVServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, format: str, *args: object) -> None:
        sys.stderr.write(
            "%s - - [%s] %s\n"
            % (self.address_string(), self.log_date_time_string(), format % args)
        )

    def _send_json(self, status: int, payload: Any | None = None) -> None:
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _route(self) -> tuple[str, str | None]:
        path = urlsplit(self.path).path
        if path == "/health":
            return "health", None
        if path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if path.startswith(prefix):
            encoded_key = path[len(prefix) :]
            try:
                key = unquote_to_bytes(encoded_key).decode("utf-8", errors="strict")
            except (UnicodeDecodeError, ValueError):
                return "invalid-key", None
            if not key or "/" in key:
                return "invalid-key", None
            return "key", key
        return "unknown", None

    def _read_put_body(self) -> dict[str, Any] | None:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            return None
        try:
            length = int(raw_length, 10)
        except ValueError:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length < 0:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length > MAX_BODY_SIZE:
            # Consume the announced body before closing the connection.  Sending
            # the error and closing immediately can reset clients that are still
            # transmitting the body, preventing them from receiving the 413.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            return None
        raw = self.rfile.read(length)
        if len(raw) != length:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "incomplete request body")
            return None
        try:
            payload = json.loads(raw, parse_constant=PersistentStore._reject_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return None
        if (
            not isinstance(payload, dict)
            or "value" not in payload
            or not set(payload).issubset({"value", "ttl_seconds"})
        ):
            self._error(
                HTTPStatus.BAD_REQUEST,
                "body must be an object containing value and optional ttl_seconds",
            )
            return None
        if "ttl_seconds" in payload:
            ttl = payload["ttl_seconds"]
            if (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and positive")
                return None
        return payload

    def _run_store_operation(self, operation: Any) -> Any:
        try:
            return operation()
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage failure")
            return None

    def do_GET(self) -> None:
        route, key = self._route()
        if route == "health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
        elif route == "keys":
            keys = self._run_store_operation(self.kv_server.store.keys)
            if keys is not None:
                self._send_json(HTTPStatus.OK, {"keys": keys})
        elif route == "key":
            result = self._run_store_operation(lambda: self.kv_server.store.get(key))
            if result is not None:
                found, value = result
                if found:
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
        elif route == "invalid-key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
        else:
            self._error(HTTPStatus.NOT_FOUND, "route not found")

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "invalid-key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
            return
        if route != "key":
            if route in {"health", "keys"}:
                self._method_not_allowed("GET")
            else:
                self._error(HTTPStatus.NOT_FOUND, "route not found")
            return
        payload = self._read_put_body()
        if payload is None:
            return
        ttl = payload.get("ttl_seconds")
        created = self._run_store_operation(
            lambda: self.kv_server.store.put(key, payload["value"], ttl)
        )
        if created is not None:
            self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key})

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "invalid-key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
        elif route == "key":
            deleted = self._run_store_operation(lambda: self.kv_server.store.delete(key))
            if deleted is True:
                self._send_json(HTTPStatus.NO_CONTENT)
            elif deleted is False:
                self._error(HTTPStatus.NOT_FOUND, "key not found")
        elif route in {"health", "keys"}:
            self._method_not_allowed("GET")
        else:
            self._error(HTTPStatus.NOT_FOUND, "route not found")

    def _method_not_allowed(self, allow: str) -> None:
        body = json.dumps({"error": "method not allowed"}, separators=(",", ":")).encode()
        self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
        self.send_header("Allow", allow)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _unsupported(self) -> None:
        route, _ = self._route()
        if route == "unknown":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
        elif route == "invalid-key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid key")
        elif route == "key":
            self._method_not_allowed("GET, PUT, DELETE")
        else:
            self._method_not_allowed("GET")

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
        store = PersistentStore(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup error: {exc}", file=sys.stderr)
        return 1

    def terminate(signum: int, frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, terminate)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
