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
from urllib.parse import unquote, urlsplit


MAX_BODY = 1024 * 1024


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle, parse_constant=self._bad_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            entries = document.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("data file has no valid entries object")
            loaded: dict[str, dict[str, Any]] = {}
            now = time.time()
            removed_expired = False
            for key, item in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("data file contains an invalid key")
                if not isinstance(item, dict) or set(item) != {"value", "expires_at"}:
                    raise ValueError("data file contains an invalid entry")
                expiry = item["expires_at"]
                if expiry is not None and (
                    isinstance(expiry, bool)
                    or not isinstance(expiry, (int, float))
                    or not math.isfinite(expiry)
                ):
                    raise ValueError("data file contains an invalid expiry")
                if expiry is not None and expiry <= now:
                    removed_expired = True
                    continue
                loaded[key] = {"value": item["value"], "expires_at": expiry}
            self.entries = loaded
            if removed_expired:
                self._persist_locked(loaded)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _bad_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _live_snapshot_locked(self) -> tuple[dict[str, dict[str, Any]], bool]:
        now = time.time()
        live = {
            key: item
            for key, item in self.entries.items()
            if item["expires_at"] is None or item["expires_at"] > now
        }
        return live, len(live) != len(self.entries)

    def _persist_locked(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(
                    {"version": 1, "entries": entries},
                    handle,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, self.path)
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except Exception:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
            raise

    def _purge_locked(self) -> None:
        live, changed = self._live_snapshot_locked()
        if changed:
            self._persist_locked(live)
            self.entries = live

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            live, _ = self._live_snapshot_locked()
            created = key not in live
            updated = dict(live)
            updated[key] = {
                "value": value,
                "expires_at": None if ttl is None else time.time() + ttl,
            }
            self._persist_locked(updated)
            self.entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._purge_locked()
            item = self.entries.get(key)
            return (False, None) if item is None else (True, item["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            live, _ = self._live_snapshot_locked()
            if key not in live:
                if len(live) != len(self.entries):
                    self._persist_locked(live)
                    self.entries = live
                return False
            updated = dict(live)
            del updated[key]
            self._persist_locked(updated)
            self.entries = updated
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._purge_locked()
            return sorted(self.entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: KVServer

    def _json(self, status: int, body: Any | None = None) -> None:
        payload = b"" if body is None else json.dumps(
            body, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload and self.command != "HEAD":
            self.wfile.write(payload)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def send_error(
        self, code: int, message: str | None = None, explain: str | None = None
    ) -> None:
        self._error(code, message or self.responses.get(code, ("Error",))[0])

    def _key(self) -> str | None:
        path = urlsplit(self.path).path
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix) :]
        if not encoded or "/" in encoded:
            raise ValueError("key must be non-empty and may not contain '/' characters")
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                if index + 2 >= len(encoded) or any(
                    character not in "0123456789abcdefABCDEF"
                    for character in encoded[index + 1 : index + 3]
                ):
                    raise ValueError("key has invalid percent encoding")
                index += 3
            else:
                index += 1
        try:
            key = unquote(encoded, encoding="utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ValueError("key is not valid UTF-8") from exc
        if not key or "/" in key:
            raise ValueError("key must be non-empty and may not contain '/' characters")
        return key

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding"):
            raise RequestError(400, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise RequestError(400, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            # Consume a bounded amount before closing.  In particular this drains
            # the common MAX_BODY + 1 case, avoiding a TCP reset that can hide the
            # JSON 413 response from clients, without trusting an arbitrarily
            # large Content-Length value.
            self.rfile.read(min(length, MAX_BODY + 1))
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        data = self.rfile.read(length)
        if len(data) != length:
            raise RequestError(400, "incomplete request body")
        try:
            return json.loads(data, parse_constant=Store._bad_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise RequestError(400, "malformed JSON") from exc

    def do_PUT(self) -> None:
        try:
            key = self._key()
            if key is None:
                self._error(404, "route not found")
                return
            body = self._read_json()
            if not isinstance(body, dict) or "value" not in body or not set(body) <= {
                "value",
                "ttl_seconds",
            }:
                raise RequestError(400, "body must contain value and optional ttl_seconds")
            ttl = body.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(400, "ttl_seconds must be finite and greater than zero")
            created = self.server.store.put(key, body["value"], ttl)
            self._json(201 if created else 200, {"key": key, "value": body["value"]})
        except ValueError as exc:
            self._error(400, str(exc))
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except OSError as exc:
            self.log_error("persistence failure: %s", exc)
            self._error(500, "persistence failure")

    def do_GET(self) -> None:
        try:
            path = urlsplit(self.path).path
            if path == "/health":
                self._json(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._json(200, {"keys": self.server.store.keys()})
                return
            key = self._key()
            if key is None:
                self._error(404, "route not found")
                return
            present, value = self.server.store.get(key)
            if not present:
                self._error(404, "key not found")
                return
            self._json(200, {"key": key, "value": value})
        except ValueError as exc:
            self._error(400, str(exc))
        except OSError as exc:
            self.log_error("persistence failure: %s", exc)
            self._error(500, "persistence failure")

    def do_DELETE(self) -> None:
        try:
            key = self._key()
            if key is None:
                self._error(404, "route not found")
                return
            if self.server.store.delete(key):
                self._json(204)
            else:
                self._error(404, "key not found")
        except ValueError as exc:
            self._error(400, str(exc))
        except OSError as exc:
            self.log_error("persistence failure: %s", exc)
            self._error(500, "persistence failure")

    def _method_not_allowed(self) -> None:
        self.close_connection = True
        self._error(405, "method not allowed")

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_CONNECT = _method_not_allowed
    do_TRACE = _method_not_allowed


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
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
