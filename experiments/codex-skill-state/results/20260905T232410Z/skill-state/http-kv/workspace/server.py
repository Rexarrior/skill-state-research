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
from typing import Any
from urllib.parse import unquote, urlsplit


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


def strict_json_loads(data: bytes | str) -> Any:
    return json.loads(
        data,
        parse_constant=lambda value: (_ for _ in ()).throw(
            ValueError(f"invalid JSON constant: {value}")
        ),
    )


class Store:
    """Lock-protected in-memory state backed by an atomically replaced JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            document = strict_json_loads(self.path.read_text(encoding="utf-8"))
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("expected an object containing an entries object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, item in raw_entries.items():
                if not isinstance(key, str) or not isinstance(item, dict):
                    raise ValueError("invalid entry")
                if set(item) != {"value", "expires_at"}:
                    raise ValueError("invalid entry fields")
                expiry = item["expires_at"]
                if expiry is not None and (
                    isinstance(expiry, bool)
                    or not isinstance(expiry, (int, float))
                    or not math.isfinite(expiry)
                ):
                    raise ValueError("invalid expiration timestamp")
                loaded[key] = {"value": item["value"], "expires_at": expiry}
            self.entries = loaded
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        with self.lock:
            changed = self._purge_locked()
            if changed:
                self._persist_locked()

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [
            key
            for key, item in self.entries.items()
            if item["expires_at"] is not None and item["expires_at"] <= now
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {"entries": self.entries},
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
        temp_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temp_name = temporary.name
                temporary.write(payload)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temp_name, self.path)
            temp_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Directory fsync is unavailable on some supported platforms.
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
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl is None else time.time() + ttl,
            }
            self._persist_locked()
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            changed = self._purge_locked()
            if changed:
                self._persist_locked()
            item = self.entries.get(key)
            return (False, None) if item is None else (True, item["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            changed = self._purge_locked()
            present = key in self.entries
            if present:
                del self.entries[key]
            if changed or present:
                self._persist_locked()
            return present

    def keys(self) -> list[str]:
        with self.lock:
            changed = self._purge_locked()
            if changed:
                self._persist_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        super().__init__(address, Handler)
        self.store = store


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _json(self, status: int, body: Any | None = None) -> None:
        encoded = b"" if body is None else json.dumps(
            body, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded and self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _route(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        path = parsed.path
        if parsed.query or parsed.fragment:
            return "unknown", None
        if path == "/health":
            return "health", None
        if path == "/v1/keys":
            return "keys", None
        if path.startswith(KEY_PREFIX):
            raw_key = path[len(KEY_PREFIX) :]
            if not raw_key or "/" in raw_key or BAD_PERCENT_ESCAPE.search(raw_key):
                return "bad_key", None
            try:
                key = unquote(raw_key, encoding="utf-8", errors="strict")
            except UnicodeDecodeError:
                return "bad_key", None
            if not key or "/" in key:
                return "bad_key", None
            return "key", key
        return "unknown", None

    def _read_json(self) -> tuple[bool, Any]:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            self._error(400, "Transfer-Encoding is not supported")
            return False, None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "Content-Length is required")
            return False, None
        try:
            length = int(raw_length, 10)
        except ValueError:
            self._error(400, "invalid Content-Length")
            return False, None
        if length < 0:
            self._error(400, "invalid Content-Length")
            return False, None
        if length > MAX_BODY:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
            self._error(413, "request body exceeds 1 MiB")
            return False, None
        media_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            self._error(415, "Content-Type must be application/json")
            return False, None
        data = self.rfile.read(length)
        if len(data) != length:
            self._error(400, "incomplete request body")
            return False, None
        try:
            return True, strict_json_loads(data)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(400, "malformed JSON")
            return False, None

    def do_GET(self) -> None:
        route, key = self._route()
        if route == "health":
            self._json(200, {"status": "ok"})
        elif route == "keys":
            self._json(200, {"keys": self.server.store.keys()})
        elif route == "key":
            found, value = self.server.store.get(key or "")
            if found:
                self._json(200, {"key": key, "value": value})
            else:
                self._error(404, "key not found")
        elif route == "bad_key":
            self._error(400, "invalid key")
        else:
            self._error(404, "route not found")

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "bad_key":
            self._error(400, "invalid key")
            return
        if route != "key":
            self._error(404, "route not found")
            return
        ok, document = self._read_json()
        if not ok:
            return
        if not isinstance(document, dict) or "value" not in document or not set(document) <= {
            "value", "ttl_seconds"
        }:
            self._error(400, "body must contain value and optional ttl_seconds")
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            created = self.server.store.put(key or "", document["value"], ttl)
        except (OSError, TypeError, ValueError) as exc:
            print(f"persistence error: {exc}", file=sys.stderr)
            self._error(500, "could not persist data")
            return
        self._json(201 if created else 200, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "bad_key":
            self._error(400, "invalid key")
        elif route != "key":
            self._error(404, "route not found")
        elif self.server.store.delete(key or ""):
            self._json(204)
        else:
            self._error(404, "key not found")

    def _method_not_allowed(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_HEAD = _method_not_allowed


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
