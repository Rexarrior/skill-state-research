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


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


class PersistentStore:
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
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported persistence format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("entries must be an object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid persisted key")
                if not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("invalid persisted entry")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid persisted expiry")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
            if self._prune_locked(time.time()):
                self._persist_locked()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
            raise StoreError(f"cannot load data file {self.path}: {error}") from error

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _prune_locked(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if not self._is_live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        document = {"version": 1, "entries": self.entries}
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=parent, prefix=f".{self.path.name}.",
                suffix=".tmp", delete=False
            ) as temporary:
                temporary_name = temporary.name
                json.dump(document, temporary, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                temporary.write("\n")
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Directory fsync is unavailable on some platforms. The file has
                # still been flushed and replaced atomically.
                pass
        except (OSError, TypeError, ValueError) as error:
            raise StoreError(f"cannot persist data file {self.path}: {error}") from error
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self.lock:
            previous = dict(self.entries)
            self._prune_locked(time.time())
            existed = key in self.entries
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                self.entries = previous
                raise
            return existed

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if not self._is_live(entry, time.time()):
                del self.entries[key]
                self._persist_best_effort_locked()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            previous = dict(self.entries)
            self._prune_locked(time.time())
            if key not in self.entries:
                return False
            del self.entries[key]
            try:
                self._persist_locked()
            except StoreError:
                self.entries = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._prune_locked(time.time()):
                self._persist_best_effort_locked()
            return sorted(self.entries)

    def _persist_best_effort_locked(self) -> None:
        try:
            self._persist_locked()
        except StoreError as error:
            print(error, file=sys.stderr, flush=True)


class KeyValueHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: PersistentStore) -> None:
        super().__init__(address, RequestHandler)
        self.store = store


class RequestHandler(BaseHTTPRequestHandler):
    server: KeyValueHTTPServer
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def do_OPTIONS(self) -> None:
        self._dispatch("OPTIONS")

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"{self.client_address[0]} - {format_string % args}", file=sys.stderr, flush=True)

    def _dispatch(self, method: str) -> None:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self._send_error(400, "invalid URL")
            return
        if parsed.query or parsed.fragment:
            self._send_error(404, "unknown route")
            return

        if parsed.path == "/health":
            if method != "GET":
                self._method_not_allowed("GET")
            else:
                self._send_json(200, {"status": "ok"})
            return

        if parsed.path == "/v1/keys":
            if method != "GET":
                self._method_not_allowed("GET")
            else:
                self._send_json(200, {"keys": self.server.store.keys()})
            return

        prefix = "/v1/kv/"
        if parsed.path.startswith(prefix):
            raw_key = parsed.path[len(prefix):]
            try:
                key = unquote_to_bytes(raw_key).decode("utf-8", errors="strict")
            except (UnicodeDecodeError, ValueError):
                self._send_error(400, "key must be valid UTF-8")
                return
            if not key or "/" in key:
                self._send_error(400, "key must be non-empty and must not contain '/'")
                return
            if method == "GET":
                self._handle_get(key)
            elif method == "PUT":
                self._handle_put(key)
            elif method == "DELETE":
                self._handle_delete(key)
            else:
                self._method_not_allowed("GET, PUT, DELETE")
            return

        self._send_error(404, "unknown route")

    def _read_json(self) -> tuple[bool, Any]:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._send_error(400, "Transfer-Encoding is not supported")
            return False, None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._send_error(411, "Content-Length is required")
            return False, None
        try:
            length = int(raw_length, 10)
        except ValueError:
            self.close_connection = True
            self._send_error(400, "invalid Content-Length")
            return False, None
        if length < 0:
            self.close_connection = True
            self._send_error(400, "invalid Content-Length")
            return False, None
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._send_error(413, "request body exceeds 1 MiB")
            return False, None
        body = self.rfile.read(length)
        try:
            text = body.decode("utf-8", errors="strict")
            value = json.loads(text, parse_constant=PersistentStore._reject_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._send_error(400, "malformed JSON")
            return False, None
        return True, value

    def _handle_put(self, key: str) -> None:
        ok, body = self._read_json()
        if not ok:
            return
        if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
            self._send_error(400, "body must be an object containing value and optional ttl_seconds")
            return
        ttl = body.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._send_error(400, "ttl_seconds must be finite and greater than zero")
            return
        try:
            replaced = self.server.store.put(key, body["value"], ttl)
        except StoreError as error:
            print(error, file=sys.stderr, flush=True)
            self._send_error(500, "failed to persist value")
            return
        self._send_json(200 if replaced else 201, {"key": key, "value": body["value"]})

    def _handle_get(self, key: str) -> None:
        try:
            found, value = self.server.store.get(key)
        except StoreError as error:
            print(error, file=sys.stderr, flush=True)
            self._send_error(500, "failed to persist expiry cleanup")
            return
        if not found:
            self._send_error(404, "key not found")
        else:
            self._send_json(200, {"key": key, "value": value})

    def _handle_delete(self, key: str) -> None:
        try:
            deleted = self.server.store.delete(key)
        except StoreError as error:
            print(error, file=sys.stderr, flush=True)
            self._send_error(500, "failed to persist deletion")
            return
        if not deleted:
            self._send_error(404, "key not found")
        else:
            self._send_empty(204)

    def _method_not_allowed(self, allow: str) -> None:
        self._send_json(405, {"error": "method not allowed"}, {"Allow": allow})

    def _send_error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_json(self, status: int, value: Any, headers: dict[str, str] | None = None) -> None:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        if headers:
            for name, header_value in headers.items():
                self.send_header(name, header_value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)


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
        store = PersistentStore(args.data)
        server = KeyValueHTTPServer((args.host, args.port), store)
    except (OSError, StoreError) as error:
        print(error, file=sys.stderr, flush=True)
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
