#!/usr/bin/env python3
"""A small, persistent HTTP key-value service."""

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


MAX_BODY_BYTES = 1024 * 1024


class Store:
    """Thread-safe JSON-file-backed key-value storage."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                document = json.load(stream, parse_constant=self._reject_constant)
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("invalid top-level structure")

            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            discarded = False
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError("invalid entry")
                if set(entry) - {"value", "expires_at"} or "value" not in entry:
                    raise ValueError("invalid entry structure")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiration")
                if self._is_live(entry, now):
                    loaded[key] = entry
                else:
                    discarded = True
            self.entries = loaded
            if discarded:
                self._persist_locked()
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON number: {value}")

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if not self._is_live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(
                    {"entries": self.entries},
                    stream,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, self.path)
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some filesystems do not support syncing directories.
                pass
        except Exception:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked()
            created = key not in self.entries
            previous = self.entries.get(key)
            expires_at = None if ttl is None else time.time() + ttl
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except Exception:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            purged = self._purge_locked()
            if purged:
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            changed = self._purge_locked()
            present = key in self.entries
            previous = self.entries.pop(key, None)
            if changed or present:
                try:
                    self._persist_locked()
                except Exception:
                    if present:
                        self.entries[key] = previous
                    raise
            return present

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_locked():
                self._persist_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = False

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _send_json(self, status: int, payload: Any | None = None) -> None:
        encoded = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded and self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _route(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if not parsed.path.startswith(prefix):
            return "unknown", None
        encoded_key = parsed.path[len(prefix) :]
        if "/" in encoded_key:
            return "invalid_key", None
        try:
            index = 0
            while True:
                index = encoded_key.find("%", index)
                if index < 0:
                    break
                escape = encoded_key[index + 1 : index + 3]
                if len(escape) != 2 or any(char not in "0123456789abcdefABCDEF" for char in escape):
                    raise ValueError
                index += 3
            key = unquote_to_bytes(encoded_key).decode("utf-8")
        except (UnicodeDecodeError, ValueError):
            return "invalid_key", None
        if not key or "/" in key:
            return "invalid_key", None
        return "kv", key

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(400, "transfer encoding is not supported")
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            raise RequestError(400, "Content-Length is required")
        try:
            length = int(content_length, 10)
        except ValueError as exc:
            raise RequestError(400, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        if len(body) != length:
            raise RequestError(400, "incomplete request body")
        try:
            return json.loads(body.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            raise RequestError(400, "malformed JSON") from exc

    def do_GET(self) -> None:
        route, key = self._route()
        try:
            if route == "health":
                self._send_json(200, {"status": "ok"})
            elif route == "keys":
                self._send_json(200, {"keys": self.server.store.keys()})
            elif route == "kv":
                found, value = self.server.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._send_json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            elif route == "invalid_key":
                self._error(400, "invalid key")
            else:
                self._error(404, "route not found")
        except OSError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._error(400, "invalid key")
            return
        if route != "kv":
            self._error(404, "route not found")
            return
        try:
            body = self._read_json()
            if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                raise RequestError(400, "body must contain value and optional ttl_seconds")
            ttl = body.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(400, "ttl_seconds must be a finite number greater than zero")
            created = self.server.store.put(key, body["value"], ttl)  # type: ignore[arg-type]
            self._send_json(201 if created else 200, {"key": key, "value": body["value"]})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._error(400, "invalid key")
            return
        if route != "kv":
            self._error(404, "route not found")
            return
        try:
            if self.server.store.delete(key):  # type: ignore[arg-type]
                self._send_json(204)
            else:
                self._error(404, "key not found")
        except OSError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def _unsupported(self) -> None:
        self._error(405, "method not allowed")

    do_HEAD = _unsupported
    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported
    do_CONNECT = _unsupported
    do_TRACE = _unsupported


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


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
