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


MAX_BODY = 1024 * 1024


class StoreError(Exception):
    pass


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is None or expires_at > now

    def _prune(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._bad_constant)
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("invalid top-level structure")
            loaded: dict[str, dict[str, Any]] = {}
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
                    raise ValueError("invalid stored expiry")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
            if self._prune(time.time()):
                self._persist()
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _bad_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=parent, prefix=f".{self.path.name}.", delete=False
            ) as output:
                temporary = output.name
                json.dump(
                    {"entries": self.entries}, output, ensure_ascii=False, separators=(",", ":"), allow_nan=False
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
                pass
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data: {exc}") from exc
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            now = time.time()
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if not self._live(entry, now):
                del self.entries[key]
                self._persist()
                return False, None
            return True, entry["value"]

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            old = self.entries.get(key)
            created = old is None or not self._live(old, now)
            previous = old
            self.entries[key] = {"value": value, "expires_at": None if ttl is None else now + ttl}
            try:
                self._prune(now)
                self._persist()
            except StoreError:
                if previous is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = previous
                raise
            return created

    def delete(self, key: str) -> bool:
        with self.lock:
            now = time.time()
            entry = self.entries.get(key)
            if entry is None:
                return False
            if not self._live(entry, now):
                del self.entries[key]
                self._persist()
                return False
            previous = self.entries.pop(key)
            try:
                self._persist()
            except StoreError:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._prune(time.time()):
                self._persist()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _key(self) -> tuple[str | None, str | None]:
        parsed = urlsplit(self.path)
        prefix = "/v1/kv/"
        if parsed.query or parsed.fragment or not parsed.path.startswith(prefix):
            return None, "unknown route"
        encoded = parsed.path[len(prefix) :]
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            return None, "key must be valid UTF-8"
        if not key or "/" in key:
            return None, "key must be non-empty and must not contain '/'"
        return key, None

    def _body(self) -> tuple[dict[str, Any] | None, tuple[int, str] | None]:
        if self.headers.get("Transfer-Encoding") is not None:
            return None, (HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
        length_text = self.headers.get("Content-Length")
        if length_text is None:
            return None, (HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
        try:
            length = int(length_text)
        except ValueError:
            return None, (HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        if length < 0:
            return None, (HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            return None, (HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw, parse_constant=Store._bad_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            return None, (HTTPStatus.BAD_REQUEST, "malformed JSON")
        if not isinstance(body, dict):
            return None, (HTTPStatus.BAD_REQUEST, "request body must be a JSON object")
        return body, None

    def _store_error(self, exc: StoreError) -> None:
        print(str(exc), file=sys.stderr)
        self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage operation failed")

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if not parsed.query and parsed.path == "/health":
            self._json(HTTPStatus.OK, {"status": "ok"})
            return
        if not parsed.query and parsed.path == "/v1/keys":
            try:
                self._json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            except StoreError as exc:
                self._store_error(exc)
            return
        key, error = self._key()
        if key is None:
            self._error(HTTPStatus.NOT_FOUND, error or "unknown route")
            return
        try:
            found, value = self.server.store.get(key)
        except StoreError as exc:
            self._store_error(exc)
            return
        if not found:
            self._error(HTTPStatus.NOT_FOUND, "key not found")
            return
        self._json(HTTPStatus.OK, {"key": key, "value": value})

    def do_PUT(self) -> None:
        key, error = self._key()
        if key is None:
            self._error(HTTPStatus.BAD_REQUEST if error != "unknown route" else HTTPStatus.NOT_FOUND, error or "invalid key")
            return
        body, body_error = self._body()
        if body_error is not None:
            self._error(*body_error)
            return
        assert body is not None
        if "value" not in body or not set(body).issubset({"value", "ttl_seconds"}):
            self._error(HTTPStatus.BAD_REQUEST, "body requires value and may only include ttl_seconds")
            return
        ttl = body.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0
        ):
            self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.server.store.put(key, body["value"], ttl)
        except StoreError as exc:
            self._store_error(exc)
            return
        self._json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": body["value"]})

    def do_DELETE(self) -> None:
        key, error = self._key()
        if key is None:
            self._error(HTTPStatus.BAD_REQUEST if error != "unknown route" else HTTPStatus.NOT_FOUND, error or "invalid key")
            return
        try:
            deleted = self.server.store.delete(key)
        except StoreError as exc:
            self._store_error(exc)
            return
        if not deleted:
            self._error(HTTPStatus.NOT_FOUND, "key not found")
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unsupported(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


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
        store = Store(args.data)
        server = Server((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: object) -> None:
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
