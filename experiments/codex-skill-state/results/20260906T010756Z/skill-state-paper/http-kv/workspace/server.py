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


MAX_BODY_BYTES = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
VALID_PERCENT_ESCAPE = re.compile(r"%(?:[0-9A-Fa-f]{2})")


class Store:
    """Thread-safe JSON-backed key-value store."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        with self.lock:
            if not self.path.exists():
                return
            try:
                with self.path.open("r", encoding="utf-8") as source:
                    document = json.load(source, parse_constant=self._reject_constant)
                raw_entries = document["entries"]
                if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                    raise ValueError("invalid persistence document")
                loaded: dict[str, dict[str, Any]] = {}
                for key, entry in raw_entries.items():
                    if not isinstance(key, str) or not isinstance(entry, dict):
                        raise ValueError("invalid persistence entry")
                    if set(entry) != {"value", "expires_at"}:
                        raise ValueError("invalid persistence entry")
                    expires_at = entry["expires_at"]
                    if expires_at is not None and (
                        isinstance(expires_at, bool)
                        or not isinstance(expires_at, (int, float))
                        or not math.isfinite(expires_at)
                    ):
                        raise ValueError("invalid expiration timestamp")
                    loaded[key] = {"value": entry["value"], "expires_at": expires_at}
                self.entries = loaded
            except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

            if self._prune_locked():
                self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    def _prune_locked(self) -> bool:
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
        file_descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(file_descriptor, "w", encoding="utf-8") as target:
                json.dump(
                    {"entries": self.entries},
                    target,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                target.write("\n")
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary_name, self.path)
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Directory fsync is unavailable on some platforms/filesystems.
                pass
        except BaseException:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self.lock:
            pruned = self._prune_locked()
            created = key not in self.entries
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except BaseException:
                # Reloading restores disk state and prevents an unpersisted write
                # from being served as if it had succeeded.
                self.entries = {}
                self._load()
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            if self._prune_locked():
                self._persist_locked()
            if key not in self.entries:
                return False, None
            return True, self.entries[key]["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            changed = self._prune_locked()
            if key not in self.entries:
                if changed:
                    self._persist_locked()
                return False
            del self.entries[key]
            self._persist_locked()
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._prune_locked():
                self._persist_locked()
            return sorted(self.entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        super().__init__(address, RequestHandler)
        self.store = store


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _send_json(self, status: int, document: Any) -> None:
        payload = json.dumps(
            document, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _send_error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _route(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        if parsed.path.startswith(KEY_PREFIX):
            encoded = parsed.path[len(KEY_PREFIX) :]
            if "/" in encoded or not encoded:
                return "invalid_key", None
            without_escapes = VALID_PERCENT_ESCAPE.sub("", encoded)
            if "%" in without_escapes:
                return "invalid_key", None
            try:
                key = unquote_to_bytes(encoded).decode("utf-8")
            except UnicodeDecodeError:
                return "invalid_key", None
            if not key or "/" in key:
                return "invalid_key", None
            return "key", key
        return "unknown", None

    def _read_json(self) -> tuple[bool, Any]:
        if self.headers.get("Transfer-Encoding") is not None:
            self._send_error(400, "transfer encoding is not supported")
            return False, None
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._send_error(411, "Content-Length is required")
            return False, None
        try:
            length = int(content_length)
        except ValueError:
            self._send_error(400, "invalid Content-Length")
            return False, None
        if length < 0:
            self._send_error(400, "invalid Content-Length")
            return False, None
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._send_error(413, "request body exceeds 1 MiB")
            return False, None
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            self._send_error(400, "incomplete request body")
            return False, None
        try:
            return True, json.loads(
                body.decode("utf-8"), parse_constant=Store._reject_constant
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._send_error(400, "malformed JSON")
            return False, None

    def do_GET(self) -> None:
        route, key = self._route()
        if route == "health":
            self._send_json(200, {"status": "ok"})
        elif route == "keys":
            self._send_json(200, {"keys": self.server.store.keys()})
        elif route == "key":
            found, value = self.server.store.get(key)  # type: ignore[arg-type]
            if found:
                self._send_json(200, {"key": key, "value": value})
            else:
                self._send_error(404, "key not found")
        elif route == "invalid_key":
            self._send_error(400, "invalid key")
        else:
            self._send_error(404, "route not found")

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._send_error(400, "invalid key")
            return
        if route != "key":
            self._send_error(404, "route not found")
            return
        parsed, document = self._read_json()
        if not parsed:
            return
        if not isinstance(document, dict) or "value" not in document:
            self._send_error(400, "body must be an object containing value")
            return
        if not set(document).issubset({"value", "ttl_seconds"}):
            self._send_error(400, "body contains unknown fields")
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._send_error(400, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.server.store.put(key, document["value"], ttl)  # type: ignore[arg-type]
        except OSError as exc:
            self.log_error("persistence failure: %s", exc)
            self._send_error(500, "failed to persist value")
            return
        self._send_json(201 if created else 200, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._send_error(400, "invalid key")
        elif route != "key":
            self._send_error(404, "route not found")
        elif self.server.store.delete(key):  # type: ignore[arg-type]
            self._send_empty(204)
        else:
            self._send_error(404, "key not found")

    def _unsupported(self) -> None:
        self._send_error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True, type=Path)
    arguments = parser.parse_args()
    if not 0 <= arguments.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return arguments


def main() -> int:
    arguments = parse_arguments()
    try:
        store = Store(arguments.data)
        server = KVServer((arguments.host, arguments.port), store)
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
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
