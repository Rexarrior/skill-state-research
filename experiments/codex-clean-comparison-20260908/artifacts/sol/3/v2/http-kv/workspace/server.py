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
from urllib.parse import unquote


MAX_BODY = 1024 * 1024


class Store:
    """Thread-safe persistent store."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=_reject_constant)
        except FileNotFoundError:
            return
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        if not isinstance(document, dict) or document.get("version") != 1:
            raise RuntimeError(f"invalid data file format: {self.path}")
        raw_entries = document.get("entries")
        if not isinstance(raw_entries, dict):
            raise RuntimeError(f"invalid data file format: {self.path}")

        now = time.time()
        loaded: dict[str, dict[str, Any]] = {}
        expired = False
        for key, entry in raw_entries.items():
            if (
                not isinstance(key, str)
                or not key
                or "/" in key
                or not isinstance(entry, dict)
                or set(entry) != {"value", "expires_at"}
            ):
                raise RuntimeError(f"invalid entry in data file: {self.path}")
            expires_at = entry["expires_at"]
            if expires_at is not None and (
                isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or not math.isfinite(expires_at)
            ):
                raise RuntimeError(f"invalid expiration in data file: {self.path}")
            if expires_at is not None and expires_at <= now:
                expired = True
                continue
            loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        self.entries = loaded
        if expired:
            self._persist_locked()

    def _remove_expired_locked(self) -> bool:
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
        self.path.parent.mkdir(parents=True, exist_ok=True)
        document = {"version": 1, "entries": self.entries}
        fd, temporary = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    document,
                    handle,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
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
            removed = self._remove_expired_locked()
            created = key not in self.entries
            expires_at = None if ttl is None else time.time() + ttl
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except BaseException:
                # Reloading restores the last successfully persisted state.
                self.entries = {}
                self._load()
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            removed = self._remove_expired_locked()
            if removed:
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            removed = self._remove_expired_locked()
            present = key in self.entries
            if present:
                del self.entries[key]
            if removed or present:
                self._persist_locked()
            return present

    def keys(self) -> list[str]:
        with self.lock:
            if self._remove_expired_locked():
                self._persist_locked()
            return sorted(self.entries)


def _reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant {value}")


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
        print(
            f"{self.client_address[0]} - {self.log_date_time_string()} - {fmt % args}",
            file=sys.stderr,
        )

    def _json(self, status: int, body: Any) -> None:
        encoded = json.dumps(
            body, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        # BaseHTTPRequestHandler otherwise emits an HTML 501 response for
        # unknown methods. Keep protocol-level failures JSON as well.
        if code == 501:
            code = 405
            message = "method not allowed"
        self.close_connection = True
        self._error(code, message or self.responses.get(code, ("error",))[0])

    def _key(self) -> str | None:
        prefix = "/v1/kv/"
        if not self.path.startswith(prefix):
            return None
        raw = self.path[len(prefix) :]
        if not raw or "?" in raw or "#" in raw:
            return None
        try:
            key = unquote(raw, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        if not key or "/" in key:
            return None
        return key

    def _read_json(self) -> tuple[bool, Any]:
        if self.headers.get("Transfer-Encoding") is not None:
            self._error(400, "transfer encoding is not supported")
            return False, None
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._error(411, "Content-Length is required")
            return False, None
        try:
            length = int(content_length)
        except ValueError:
            self._error(400, "invalid Content-Length")
            return False, None
        if length < 0:
            self._error(400, "invalid Content-Length")
            return False, None
        if length > MAX_BODY:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return False, None
        payload = self.rfile.read(length)
        try:
            value = json.loads(payload.decode("utf-8"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(400, "malformed JSON")
            return False, None
        return True, value

    def do_GET(self) -> None:
        try:
            if self.path == "/health":
                self._json(200, {"status": "ok"})
                return
            if self.path == "/v1/keys":
                self._json(200, {"keys": self.server.store.keys()})
                return
            key = self._key()
            if key is not None:
                found, value = self.server.store.get(key)
                if found:
                    self._json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
                return
            self._error(404, "route not found")
        except OSError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        key = self._key()
        if key is None:
            self._error(404, "route not found")
            return
        ok, body = self._read_json()
        if not ok:
            return
        if not isinstance(body, dict) or "value" not in body or not set(body) <= {
            "value",
            "ttl_seconds",
        }:
            self._error(400, "body must contain value and optional ttl_seconds")
            return
        ttl = body.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.server.store.put(key, body["value"], ttl)
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")
            return
        self._json(201 if created else 200, {"key": key, "value": body["value"]})

    def do_DELETE(self) -> None:
        key = self._key()
        if key is None:
            self._error(404, "route not found")
            return
        try:
            deleted = self.server.store.delete(key)
        except OSError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _method_not_allowed(self) -> None:
        # Do not leave an unread request body on a reusable connection.
        self.close_connection = True
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        encoded = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

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
        print(f"error: {exc}", file=sys.stderr)
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
