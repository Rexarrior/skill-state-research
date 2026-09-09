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
from urllib.parse import unquote, urlsplit


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class Store:
    """Thread-safe in-memory state backed by an atomically replaced JSON file."""

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
                document = json.load(handle, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported persistence format")
            entries = document.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("persistence entries must be an object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid key in persistence file")
                if not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("invalid entry in persistence file")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiration in persistence file")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        with self.lock:
            if self._purge_expired_locked():
                self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _purge_expired_locked(self) -> bool:
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
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        document = {"version": 1, "entries": self.entries}
        temp_name: str | None = None
        try:
            fd, temp_name = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=parent)
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
            os.replace(temp_name, self.path)
            temp_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except FileNotFoundError:
                    pass

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_expired_locked()
            created = key not in self.entries
            expires_at = None if ttl is None else time.time() + ttl
            self.entries[key] = {"value": value, "expires_at": expires_at}
            self._persist_locked()
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            if self._purge_expired_locked():
                self._persist_locked()
            if key not in self.entries:
                return False, None
            return True, self.entries[key]["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            changed = self._purge_expired_locked()
            present = key in self.entries
            if present:
                del self.entries[key]
                changed = True
            if changed:
                self._persist_locked()
            return present

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_expired_locked():
                self._persist_locked()
            return sorted(self.entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write(
            "%s - - [%s] %s\n"
            % (self.address_string(), self.log_date_time_string(), fmt % args)
        )

    def _json_response(self, status: int, payload: Any) -> None:
        data = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _empty_response(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, message: str) -> None:
        self._json_response(status, {"error": message})

    def _path(self) -> str | None:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self._error(400, "invalid request target")
            return None
        if parsed.query or parsed.fragment:
            self._error(404, "route not found")
            return None
        return parsed.path

    def _key_from_path(self, path: str) -> str | None:
        if not path.startswith(KEY_PREFIX):
            return None
        encoded = path[len(KEY_PREFIX) :]
        if not encoded or "/" in encoded or BAD_ESCAPE.search(encoded):
            raise ValueError("invalid key")
        try:
            key = unquote(encoded, encoding="utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ValueError("key is not valid UTF-8") from exc
        if not key or "/" in key:
            raise ValueError("invalid key")
        return key

    def _read_json(self) -> Any:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            raise RequestError(400, "transfer encoding is not supported")
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(length_header, 10)
        except ValueError as exc:
            raise RequestError(400, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            return json.loads(body, parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise RequestError(400, "malformed JSON") from exc

    def do_GET(self) -> None:
        path = self._path()
        if path is None:
            return
        if path == "/health":
            self._json_response(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            self._json_response(200, {"keys": self.server.store.keys()})
            return
        try:
            key = self._key_from_path(path)
        except ValueError as exc:
            self._error(400, str(exc))
            return
        if key is None:
            self._error(404, "route not found")
            return
        found, value = self.server.store.get(key)
        if not found:
            self._error(404, "key not found")
            return
        self._json_response(200, {"key": key, "value": value})

    def do_PUT(self) -> None:
        path = self._path()
        if path is None:
            return
        try:
            key = self._key_from_path(path)
        except ValueError as exc:
            self._error(400, str(exc))
            return
        if key is None:
            self._error(404, "route not found")
            return
        try:
            payload = self._read_json()
        except RequestError as exc:
            self._error(exc.status, exc.message)
            return
        if not isinstance(payload, dict):
            self._error(400, "request body must be a JSON object")
            return
        if "value" not in payload:
            self._error(400, "request body must contain value")
            return
        ttl = payload.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            created = self.server.store.put(key, payload["value"], ttl)
        except (OSError, ValueError, TypeError) as exc:
            self.log_error("persistence failed: %s", exc)
            self._error(500, "persistence failed")
            return
        self._json_response(201 if created else 200, {"key": key, "value": payload["value"]})

    def do_DELETE(self) -> None:
        path = self._path()
        if path is None:
            return
        try:
            key = self._key_from_path(path)
        except ValueError as exc:
            self._error(400, str(exc))
            return
        if key is None:
            self._error(404, "route not found")
            return
        try:
            deleted = self.server.store.delete(key)
        except OSError as exc:
            self.log_error("persistence failed: %s", exc)
            self._error(500, "persistence failed")
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self._empty_response(204)

    def _method_not_allowed(self) -> None:
        path = self._path()
        if path is None:
            return
        known = path in ("/health", "/v1/keys") or path.startswith(KEY_PREFIX)
        if not known:
            self._error(404, "route not found")
            return
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        data = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed


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
        server = KVServer((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if stopping.is_set():
            return
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
