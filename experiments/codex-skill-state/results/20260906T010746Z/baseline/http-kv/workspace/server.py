#!/usr/bin/env python3
"""A small persistent HTTP key-value service."""

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
from typing import Any, NoReturn
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_SIZE = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StorageError(Exception):
    """Raised when durable state cannot be loaded or saved."""


class Store:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            raw_entries = document["entries"]
            if not isinstance(raw_entries, dict):
                raise ValueError("entries is not an object")

            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            expired_found = False
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
                if self._is_live(entry, now):
                    loaded[key] = entry
                else:
                    expired_found = True
            self._entries = loaded
            if expired_found:
                self._persist(loaded)
        except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            raise StorageError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> NoReturn:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as temporary:
                    json.dump(
                        {"entries": entries},
                        temporary,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                    )
                    temporary.write("\n")
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_name, self.path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    # Some platforms/filesystems do not permit directory fsync.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except (OSError, RecursionError, TypeError, ValueError) as exc:
            raise StorageError(f"cannot save data file {self.path}: {exc}") from exc

    def _without_expired(self, now: float) -> tuple[dict[str, dict[str, Any]], bool]:
        live = {
            key: entry
            for key, entry in self._entries.items()
            if self._is_live(entry, now)
        }
        return live, len(live) != len(self._entries)

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self._lock:
            now = time.time()
            entries, purged = self._without_expired(now)
            created = key not in entries
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            if expires_at is not None and not math.isfinite(expires_at):
                raise ValueError("ttl_seconds produces an invalid expiration")
            entries[key] = {"value": value, "expires_at": expires_at}
            self._persist(entries)
            self._entries = entries
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            entries, purged = self._without_expired(time.time())
            if purged:
                self._entries = entries
                self._persist(entries)
            entry = entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self._lock:
            entries, purged = self._without_expired(time.time())
            present = key in entries
            if present:
                del entries[key]
            if present or purged:
                self._persist(entries)
                self._entries = entries
            return present

    def keys(self) -> list[str]:
        with self._lock:
            entries, purged = self._without_expired(time.time())
            if purged:
                self._persist(entries)
                self._entries = entries
            return sorted(entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: KVServer

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] " + format % args,
            file=sys.stderr,
        )

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        # Keep errors JSON even when BaseHTTPRequestHandler detects a bad request.
        self._send_json(code, {"error": message or "request error"})

    def __getattr__(self, name: str) -> Any:
        if name.startswith("do_"):
            return self._method_not_allowed
        raise AttributeError(name)

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

    def _method_not_allowed(self) -> None:
        self._error(405, "method not allowed")

    def _route_path(self) -> str | None:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            return None
        if parsed.query or parsed.fragment:
            return None
        return parsed.path

    def _key(self, path: str) -> str | None:
        if not path.startswith(KEY_PREFIX):
            return None
        encoded = path[len(KEY_PREFIX) :]
        if not encoded or "/" in encoded or BAD_PERCENT_ESCAPE.search(encoded):
            return None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            return None
        if not key or "/" in key:
            return None
        return key

    def _read_json(self) -> tuple[bool, Any]:
        if self.headers.get("Transfer-Encoding") is not None:
            self._error(400, "transfer encoding is not supported")
            return False, None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "Content-Length is required")
            return False, None
        if not re.fullmatch(r"[0-9]+", raw_length):
            self._error(400, "invalid Content-Length")
            return False, None
        length = int(raw_length, 10)
        if length > MAX_BODY_SIZE:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return False, None
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                self._error(400, "incomplete request body")
                return False, None
            value = json.loads(body, parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
            self._error(400, "malformed JSON")
            return False, None
        return True, value

    def do_GET(self) -> None:
        path = self._route_path()
        if path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            try:
                self._send_json(200, {"keys": self.server.store.keys()})
            except StorageError as exc:
                self.log_error("%s", exc)
                self._error(500, "storage error")
            return
        if path is not None:
            key = self._key(path)
            if key is not None:
                try:
                    found, value = self.server.store.get(key)
                except StorageError as exc:
                    self.log_error("%s", exc)
                    self._error(500, "storage error")
                    return
                if found:
                    self._send_json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
                return
            if path.startswith(KEY_PREFIX):
                self._error(400, "invalid key")
                return
        self._error(404, "route not found")

    def do_PUT(self) -> None:
        path = self._route_path()
        key = None if path is None else self._key(path)
        if key is None:
            if path is not None and path.startswith(KEY_PREFIX):
                self._error(400, "invalid key")
            else:
                self._error(404, "route not found")
            return
        ok, payload = self._read_json()
        if not ok:
            return
        if (
            not isinstance(payload, dict)
            or "value" not in payload
            or not set(payload).issubset({"value", "ttl_seconds"})
        ):
            self._error(400, "body must be an object containing value and optional ttl_seconds")
            return
        ttl = payload.get("ttl_seconds")
        if "ttl_seconds" in payload and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            created = self.server.store.put(key, payload["value"], ttl)
        except ValueError:
            self._error(400, "ttl_seconds is too large")
            return
        except StorageError as exc:
            self.log_error("%s", exc)
            self._error(500, "storage error")
            return
        self._send_json(201 if created else 200, {"key": key, "value": payload["value"]})

    def do_DELETE(self) -> None:
        path = self._route_path()
        key = None if path is None else self._key(path)
        if key is None:
            if path is not None and path.startswith(KEY_PREFIX):
                self._error(400, "invalid key")
            else:
                self._error(404, "route not found")
            return
        try:
            deleted = self.server.store.delete(key)
        except StorageError as exc:
            self.log_error("%s", exc)
            self._error(500, "storage error")
            return
        if deleted:
            self._send_json(204)
        else:
            self._error(404, "key not found")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
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
        server = KVServer((args.host, args.port), store)
    except (OSError, StorageError) as exc:
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
