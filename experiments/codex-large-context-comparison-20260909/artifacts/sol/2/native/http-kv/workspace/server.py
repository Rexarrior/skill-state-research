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


MAX_BODY_BYTES = 1024 * 1024


class StoreError(Exception):
    """Raised when persisted state cannot be read or written."""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _expired(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is not None and expires_at <= now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            entries = document.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("data-file entries must be an object")

            loaded: dict[str, dict[str, Any]] = {}
            now = time.time()
            had_expired = False
            for key, entry in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("data file contains an invalid key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("data file contains an invalid entry")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("data file contains an invalid expiry")
                normalized = {"value": entry["value"], "expires_at": expires_at}
                # Validate that values remain representable as strict JSON.
                json.dumps(normalized, allow_nan=False)
                if self._expired(normalized, now):
                    had_expired = True
                else:
                    loaded[key] = normalized
            self._entries = loaded
            if had_expired:
                self._persist_locked()
        except (OSError, ValueError, TypeError, RecursionError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON number {value}")

    def _remove_expired_locked(self, now: float) -> bool:
        expired = [key for key, entry in self._entries.items() if self._expired(entry, now)]
        for key in expired:
            del self._entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        document = {"version": 1, "entries": self._entries}
        fd = -1
        temporary: str | None = None
        try:
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                fd = -1
                json.dump(document, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            temporary = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some platforms/filesystems do not permit syncing directories.
                pass
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if fd >= 0:
                os.close(fd)
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def _purge_locked(self) -> None:
        if self._remove_expired_locked(time.time()):
            self._persist_locked()

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self._lock:
            self._purge_locked()
            existed = key in self._entries
            old_entry = self._entries.get(key)
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            self._entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                if existed:
                    self._entries[key] = old_entry  # type: ignore[assignment]
                else:
                    del self._entries[key]
                raise
            return existed

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            self._purge_locked()
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            self._purge_locked()
            if key not in self._entries:
                return False
            old_entry = self._entries.pop(key)
            try:
                self._persist_locked()
            except StoreError:
                self._entries[key] = old_entry
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            self._purge_locked()
            return sorted(self._entries)


class KVServer(ThreadingHTTPServer):
    # A client holding an idle keep-alive connection must not prevent SIGTERM
    # from completing the shutdown.
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def __getattr__(self, name: str) -> Any:
        # BaseHTTPRequestHandler otherwise turns unimplemented methods into a
        # 501 response. At the application layer they are uniformly 405/404.
        if name.startswith("do_"):
            return self._method_not_allowed
        raise AttributeError(name)

    def _send_json(self, status: int, payload: Any, *, extra_headers: dict[str, str] | None = None) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str, *, extra_headers: dict[str, str] | None = None) -> None:
        self._send_json(status, {"error": message}, extra_headers=extra_headers)

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        self._error(code, message or self.responses.get(code, ("Error",))[0])

    def _route(self) -> tuple[str, str | None]:
        try:
            path = urlsplit(self.path).path
        except ValueError:
            return "invalid", None
        if path == "/health":
            return "health", None
        if path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return "unknown", None
        raw_key = path[len(prefix) :]
        if not raw_key or "/" in raw_key or self._bad_percent_encoding(raw_key):
            return "invalid-key", None
        try:
            key = unquote_to_bytes(raw_key).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return "invalid-key", None
        if not key or "/" in key:
            return "invalid-key", None
        return "kv", key

    @staticmethod
    def _bad_percent_encoding(text: str) -> bool:
        index = 0
        hexdigits = frozenset("0123456789abcdefABCDEF")
        while index < len(text):
            if text[index] == "%":
                if index + 2 >= len(text) or text[index + 1] not in hexdigits or text[index + 2] not in hexdigits:
                    return True
                index += 3
            else:
                index += 1
        return False

    def _read_json(self) -> tuple[bool, Any]:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            self.close_connection = True
            self._error(400, "transfer encoding is not supported")
            return False, None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "Content-Length is required")
            return False, None
        try:
            length = int(raw_length, 10)
        except ValueError:
            self.close_connection = True
            self._error(400, "invalid Content-Length")
            return False, None
        if length < 0:
            self.close_connection = True
            self._error(400, "invalid Content-Length")
            return False, None
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return False, None
        body = self.rfile.read(length)
        try:
            return True, json.loads(body.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
            self._error(400, "malformed JSON")
            return False, None

    def _kv_route_or_error(self) -> tuple[bool, str | None]:
        route, key = self._route()
        if route == "invalid-key":
            self._error(400, "invalid key")
            return False, None
        if route != "kv":
            self._error(404, "route not found")
            return False, None
        return True, key

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
            elif route == "invalid-key":
                self._error(400, "invalid key")
            else:
                self._error(404, "route not found")
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        valid, key = self._kv_route_or_error()
        if not valid:
            # A request body was not consumed, so this connection cannot be
            # safely reused for another HTTP/1.1 request.
            self.close_connection = True
            return
        parsed, body = self._read_json()
        if not parsed:
            return
        if not isinstance(body, dict) or "value" not in body or not set(body).issubset({"value", "ttl_seconds"}):
            self._error(400, "body must be an object containing value and optional ttl_seconds")
            return
        ttl = body.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            # Reject non-finite numbers nested anywhere in the value.
            json.dumps(body["value"], allow_nan=False)
            replaced = self.server.store.put(key, body["value"], ttl)  # type: ignore[arg-type]
        except (ValueError, TypeError, RecursionError):
            self._error(400, "value must be valid JSON")
            return
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "storage error")
            return
        self._send_json(200 if replaced else 201, {"key": key, "value": body["value"]})

    def do_DELETE(self) -> None:
        valid, key = self._kv_route_or_error()
        if not valid:
            return
        try:
            deleted = self.server.store.delete(key)  # type: ignore[arg-type]
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "storage error")
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self.send_response(204)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _method_not_allowed(self) -> None:
        route, _ = self._route()
        if route in {"health", "keys", "kv", "invalid-key"}:
            if route == "kv":
                allow = "GET, PUT, DELETE"
            else:
                allow = "GET"
            self._error(405, "method not allowed", extra_headers={"Allow": allow})
        else:
            self._error(404, "route not found")

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_HEAD = _method_not_allowed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True, type=Path)
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        store = Store(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"server: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, name="shutdown", daemon=True).start()

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
