#!/usr/bin/env python3
"""A small persistent HTTP key-value service using only the standard library."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class Store:
    """Thread-safe store whose mutations are durably replaced on disk."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("invalid entries in data file")

            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            expired = False
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("invalid entry in data file")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiration in data file")
                normalized = {"value": entry["value"], "expires_at": expires_at}
                if self._live(normalized, now):
                    loaded[key] = normalized
                else:
                    expired = True
            self.entries = loaded
            if expired:
                self._persist_locked()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    def _purge_locked(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "entries": self.entries}
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.path.parent,
                prefix=f".{self.path.name}.", suffix=".tmp", delete=False,
            ) as temporary:
                temporary_name = temporary.name
                json.dump(payload, temporary, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                temporary.write("\n")
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = None
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._purge_locked(now)
            created = key not in self.entries
            expires_at = None if ttl is None else now + ttl
            self.entries[key] = {"value": value, "expires_at": expires_at}
            self._persist_locked()
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            now = time.time()
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if not self._live(entry, now):
                del self.entries[key]
                self._persist_locked()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            now = time.time()
            purged = self._purge_locked(now)
            present = key in self.entries
            if present:
                del self.entries[key]
            if present or purged:
                self._persist_locked()
            return present

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_locked(time.time()):
                self._persist_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        super().__init__(address, Handler)
        self.store = store

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Base implementation already writes diagnostics to stderr.
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _key(self, path: str) -> str | None:
        if not path.startswith(KEY_PREFIX):
            return None
        encoded = path[len(KEY_PREFIX):]
        if not encoded or "/" in encoded or BAD_ESCAPE.search(encoded):
            raise ValueError("invalid key")
        try:
            key = unquote(encoded, encoding="utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ValueError("key is not valid UTF-8") from exc
        if not key or "/" in key:
            raise ValueError("invalid key")
        return key

    def _read_document(self) -> Any:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            raise RequestError(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
        try:
            length = int(length_header, 10)
        except ValueError as exc:
            raise RequestError(HTTPStatus.BAD_REQUEST, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            text = body.decode("utf-8")
            return json.loads(text, parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise RequestError(HTTPStatus.BAD_REQUEST, "malformed JSON") from exc

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
            return
        if path == "/v1/keys":
            self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            return
        try:
            key = self._key(path)
        except ValueError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return
        if key is None:
            self._error(HTTPStatus.NOT_FOUND, "unknown route")
            return
        found, value = self.server.store.get(key)
        if not found:
            self._error(HTTPStatus.NOT_FOUND, "key not found")
            return
        self._send_json(HTTPStatus.OK, {"key": key, "value": value})

    def do_PUT(self) -> None:
        path = urlsplit(self.path).path
        try:
            key = self._key(path)
        except ValueError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return
        if key is None:
            self._error(HTTPStatus.NOT_FOUND, "unknown route")
            return
        try:
            document = self._read_document()
        except RequestError as exc:
            self._error(exc.status, exc.message)
            return
        if not isinstance(document, dict) or "value" not in document:
            self._error(HTTPStatus.BAD_REQUEST, "body must be an object containing value")
            return
        unexpected = set(document) - {"value", "ttl_seconds"}
        if unexpected:
            self._error(HTTPStatus.BAD_REQUEST, "body contains unsupported fields")
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.server.store.put(key, document["value"], ttl)
        except (OSError, ValueError, TypeError) as exc:
            self.log_error("persistence failed: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not persist data")
            return
        self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        path = urlsplit(self.path).path
        try:
            key = self._key(path)
        except ValueError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return
        if key is None:
            self._error(HTTPStatus.NOT_FOUND, "unknown route")
            return
        if not self.server.store.delete(key):
            self._error(HTTPStatus.NOT_FOUND, "key not found")
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unsupported(self) -> None:
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported
    do_HEAD = _unsupported
    do_CONNECT = _unsupported
    do_TRACE = _unsupported


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


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
    except (OSError, RuntimeError) as exc:
        print(f"error: {exc}", file=os.sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(signum: int, frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            # shutdown() must run outside the serve_forever() thread.
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    actual_port = server.server_address[1]
    print(f"LISTENING {actual_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
