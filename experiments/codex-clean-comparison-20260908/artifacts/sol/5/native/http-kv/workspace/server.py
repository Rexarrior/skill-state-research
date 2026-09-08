#!/usr/bin/env python3
"""A small, persistent HTTP key-value service."""

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


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


def finite_json_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("number is outside the supported range")
    return parsed


class StoreError(Exception):
    """Raised when durable storage cannot be updated."""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        except (OSError, UnicodeError) as exc:
            raise StoreError(f"cannot read data file {self.path}: {exc}") from exc

        try:
            document = json.loads(
                raw,
                parse_float=finite_json_float,
                parse_constant=self._reject_constant,
            )
            entries = document["entries"]
            if not isinstance(document, dict) or set(document) != {"entries"}:
                raise ValueError("top-level object must contain only 'entries'")
            if not isinstance(entries, dict):
                raise ValueError("'entries' must be an object")

            loaded: dict[str, dict[str, Any]] = {}
            now = time.time()
            for key, entry in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("data file contains an invalid key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError(f"invalid entry for key {key!r}")
                expires_at = entry["expires_at"]
                if expires_at is not None:
                    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
                        raise ValueError(f"invalid expiry for key {key!r}")
                    if not math.isfinite(expires_at):
                        raise ValueError(f"invalid expiry for key {key!r}")
                    if expires_at <= now:
                        continue
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise StoreError(f"invalid data file {self.path}: {exc}") from exc

        self._entries = loaded
        # If stale records were found, promptly replace the file with live state.
        if len(loaded) != len(entries):
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON number {value}")

    def _purge_locked(self, now: float) -> bool:
        expired = [
            key
            for key, entry in self._entries.items()
            if entry["expires_at"] is not None and entry["expires_at"] <= now
        ]
        for key in expired:
            del self._entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        temporary: str | None = None
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(
                    {"entries": self._entries},
                    output,
                    ensure_ascii=True,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            temporary = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some filesystems do not support syncing directory handles.
                pass
        except (OSError, TypeError, ValueError, RecursionError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def put(self, key: str, value: Any, ttl: float | int | None) -> bool:
        with self._lock:
            now = time.time()
            self._purge_locked(now)
            created = key not in self._entries
            old = self._entries.get(key)
            expires_at = None if ttl is None else now + ttl
            self._entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                if old is None:
                    del self._entries[key]
                else:
                    self._entries[key] = old
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            changed = self._purge_locked(time.time())
            if changed:
                self._persist_locked()
            entry = self._entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self._lock:
            changed = self._purge_locked(time.time())
            old = self._entries.pop(key, None)
            if old is None:
                if changed:
                    self._persist_locked()
                return False
            try:
                self._persist_locked()
            except StoreError:
                self._entries[key] = old
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            if self._purge_locked(time.time()):
                self._persist_locked()
            return sorted(self._entries)

    def flush_live(self) -> None:
        with self._lock:
            if self._purge_locked(time.time()):
                self._persist_locked()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "http-kv/1.0"

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined,no-any-return]

    def _json(self, status: int, body: Any) -> None:
        encoded = json.dumps(
            body, ensure_ascii=True, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        if code == 501:
            code = 405
            message = "method not allowed"
        self._error(code, message or self.responses.get(code, ("Error",))[0])

    def _path(self) -> str | None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return None
        return parsed.path

    def _key(self) -> tuple[str | None, str | None]:
        path = self._path()
        if path is None or not path.startswith(KEY_PREFIX):
            return None, "unknown route"
        encoded = path[len(KEY_PREFIX) :]
        if not encoded:
            return None, "key must not be empty"
        if "/" in encoded or BAD_PERCENT_ESCAPE.search(encoded):
            return None, "invalid key"
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return None, "key must be valid UTF-8"
        if not key or "/" in key:
            return None, "invalid key"
        return key, None

    def _read_json(self) -> tuple[Any | None, bool]:
        if self.headers.get("Transfer-Encoding") is not None:
            self._error(400, "transfer encoding is not supported")
            self.close_connection = True
            return None, False
        lengths = self.headers.get_all("Content-Length", failobj=[])
        if len(lengths) != 1:
            self._error(400, "exactly one Content-Length header is required")
            self.close_connection = True
            return None, False
        try:
            length = int(lengths[0], 10)
        except ValueError:
            self._error(400, "invalid Content-Length")
            self.close_connection = True
            return None, False
        if length < 0:
            self._error(400, "invalid Content-Length")
            self.close_connection = True
            return None, False
        if length > MAX_BODY:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self._error(413, "request body exceeds 1 MiB")
            self.close_connection = True
            return None, False
        raw = self.rfile.read(length)
        if len(raw) != length:
            self._error(400, "incomplete request body")
            self.close_connection = True
            return None, False
        try:
            return json.loads(
                raw,
                parse_float=finite_json_float,
                parse_constant=Store._reject_constant,
            ), True
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
            self._error(400, "malformed JSON")
            return None, False

    def do_GET(self) -> None:
        path = self._path()
        try:
            if path == "/health":
                self._json(200, {"status": "ok"})
            elif path == "/v1/keys":
                self._json(200, {"keys": self.store.keys()})
            elif path is not None and path.startswith(KEY_PREFIX):
                key, error = self._key()
                if error:
                    self._error(400, error)
                    return
                found, value = self.store.get(key)  # type: ignore[arg-type]
                if not found:
                    self._error(404, "key not found")
                else:
                    self._json(200, {"key": key, "value": value})
            else:
                self._error(404, "unknown route")
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        path = self._path()
        if path is None or not path.startswith(KEY_PREFIX):
            self._error(404, "unknown route")
            return
        key, error = self._key()
        if error:
            self._error(400, error)
            return
        body, ok = self._read_json()
        if not ok:
            return
        if not isinstance(body, dict) or "value" not in body:
            self._error(400, "body must be an object containing 'value'")
            return
        if not set(body).issubset({"value", "ttl_seconds"}):
            self._error(400, "body contains unknown fields")
            return
        ttl = body.get("ttl_seconds")
        valid_ttl = ttl is None
        if "ttl_seconds" in body:
            valid_ttl = False
            if not isinstance(ttl, bool) and isinstance(ttl, (int, float)) and ttl > 0:
                try:
                    valid_ttl = math.isfinite(ttl)
                except OverflowError:
                    valid_ttl = False
        if not valid_ttl:
            self._error(400, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.store.put(key, body["value"], ttl)  # type: ignore[arg-type]
            self._json(201 if created else 200, {"key": key, "value": body["value"]})
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "storage error")

    def do_DELETE(self) -> None:
        path = self._path()
        if path is None or not path.startswith(KEY_PREFIX):
            self._error(404, "unknown route")
            return
        key, error = self._key()
        if error:
            self._error(400, error)
            return
        try:
            if not self.store.delete(key):  # type: ignore[arg-type]
                self._error(404, "key not found")
                return
            self.send_response(204)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "storage error")

    def _unsupported(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        encoded = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported
    do_TRACE = _unsupported
    do_CONNECT = _unsupported


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
    except (OSError, StoreError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def request_stop(signum: int, frame: Any) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    print(f"LISTENING {server.server_address[1]}", flush=True)
    serving = threading.Thread(target=server.serve_forever, name="http-server")
    serving.start()
    exit_code = 0
    try:
        stopping.wait()
    finally:
        server.shutdown()
        serving.join()
        server.server_close()
        try:
            store.flush_live()
        except StoreError as exc:
            print(f"error during shutdown: {exc}", file=sys.stderr)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
