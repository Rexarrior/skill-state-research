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
from urllib.parse import unquote, urlsplit


MAX_BODY = 1024 * 1024


def _reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON number: {value}")


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                data = json.load(handle, parse_constant=_reject_constant)
            if not isinstance(data, dict) or data.get("version") != 1:
                raise ValueError("unsupported data-file format")
            raw_entries = data.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("invalid entries in data file")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if (
                    not isinstance(key, str)
                    or not key
                    or "/" in key
                    or not isinstance(entry, dict)
                    or set(entry) != {"value", "expires_at"}
                ):
                    raise ValueError("invalid entry in data file")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiry in data file")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        if self._purge_expired_locked():
            self._save_locked()

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

    def _save_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary: str | None = None
        try:
            fd, temporary = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
            )
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    {"version": 1, "entries": self.entries},
                    handle,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            temporary = None
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_expired_locked()
            old_entries = self.entries.copy()
            created = key not in self.entries
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl is None else time.time() + ttl,
            }
            try:
                self._save_locked()
            except Exception:
                self.entries = old_entries
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            purged = self._purge_expired_locked()
            if purged:
                try:
                    self._save_locked()
                except OSError as exc:
                    print(f"warning: cannot persist expiry cleanup: {exc}", file=sys.stderr)
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_expired_locked()
            if key not in self.entries:
                return False
            old_entries = self.entries.copy()
            del self.entries[key]
            try:
                self._save_locked()
            except Exception:
                self.entries = old_entries
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            purged = self._purge_expired_locked()
            if purged:
                try:
                    self._save_locked()
                except OSError as exc:
                    print(f"warning: cannot persist expiry cleanup: {exc}", file=sys.stderr)
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] {format % args}",
            file=sys.stderr,
        )

    def _json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _key(self, path: str) -> str | None:
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix) :]
        if not encoded or "/" in encoded:
            return None
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                if index + 2 >= len(encoded) or any(
                    char not in "0123456789abcdefABCDEF" for char in encoded[index + 1 : index + 3]
                ):
                    return None
                index += 3
            else:
                index += 1
        try:
            key = unquote(encoded, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        if not key or "/" in key:
            return None
        return key

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(400, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError:
            raise RequestError(400, "invalid Content-Length") from None
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        if len(body) != length:
            raise RequestError(400, "incomplete request body")
        try:
            return json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise RequestError(400, "malformed JSON") from None

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        try:
            if path == "/health":
                self._json(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._json(200, {"keys": self.server.store.keys()})
                return
            key = self._key(path)
            if key is not None:
                found, value = self.server.store.get(key)
                if found:
                    self._json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
                return
            self._error(404, "route not found")
        except OSError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        path = urlsplit(self.path).path
        key = self._key(path)
        if key is None:
            self._error(400 if path.startswith("/v1/kv/") else 404, "invalid key" if path.startswith("/v1/kv/") else "route not found")
            return
        try:
            body = self._read_json()
            if not isinstance(body, dict) or "value" not in body or not set(body) <= {
                "value",
                "ttl_seconds",
            }:
                raise RequestError(400, "body must be an object containing value and optional ttl_seconds")
            ttl = body.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(400, "ttl_seconds must be a finite number greater than zero")
            created = self.server.store.put(key, body["value"], ttl)
            self._json(201 if created else 200, {"key": key, "value": body["value"]})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except (OSError, ValueError) as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_DELETE(self) -> None:
        path = urlsplit(self.path).path
        key = self._key(path)
        if key is None:
            self._error(400 if path.startswith("/v1/kv/") else 404, "invalid key" if path.startswith("/v1/kv/") else "route not found")
            return
        try:
            if self.server.store.delete(key):
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self._error(404, "key not found")
        except OSError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def _unsupported(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        encoded = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(message)


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
