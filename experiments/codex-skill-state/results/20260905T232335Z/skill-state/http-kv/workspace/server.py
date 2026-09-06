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


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is None or expires_at > now

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _load(self) -> None:
        if not self.path.exists() or self.path.stat().st_size == 0:
            return
        with self.path.open("r", encoding="utf-8") as handle:
            document = json.load(handle, parse_constant=self._reject_constant)
        if not isinstance(document, dict) or document.get("version") != 1:
            raise ValueError("unsupported or malformed data file")
        raw_entries = document.get("entries")
        if not isinstance(raw_entries, dict):
            raise ValueError("malformed data file entries")
        loaded: dict[str, dict[str, Any]] = {}
        for key, entry in raw_entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise ValueError("malformed key in data file")
            if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                raise ValueError("malformed entry in data file")
            expires_at = entry["expires_at"]
            if expires_at is not None and (
                isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or not math.isfinite(expires_at)
            ):
                raise ValueError("malformed expiration in data file")
            loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        self.entries = loaded
        if self._purge_locked():
            self._save_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    def _save_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "entries": self.entries}
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary_name = handle.name
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = None
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Directory fsync is unavailable on some platforms/filesystems.
                pass
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked()
            existed = key in self.entries
            previous = self.entries.get(key)
            expires_at = None if ttl is None else time.time() + ttl
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._save_locked()
            except Exception:
                if previous is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = previous
                raise
            return existed

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            changed = self._purge_locked()
            if changed:
                self._save_locked()
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked()
            previous = self.entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._save_locked()
            except Exception:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            changed = self._purge_locked()
            if changed:
                self._save_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _json(self, status: int, body: Any) -> None:
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _path(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if not parsed.path.startswith(prefix):
            return "unknown", None
        raw_key = parsed.path[len(prefix):]
        if not raw_key or "/" in raw_key:
            return "invalid_key", None
        try:
            key = unquote_to_bytes(raw_key).decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError):
            return "invalid_key", None
        if not key or "/" in key:
            return "invalid_key", None
        return "kv", key

    def _read_json(self) -> Any:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            raise RequestError(400, "unsupported transfer encoding")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError:
            raise RequestError(400, "invalid Content-Length") from None
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise RequestError(400, "incomplete request body")
        try:
            return json.loads(raw.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise RequestError(400, "malformed JSON") from None

    def do_GET(self) -> None:
        route, key = self._path()
        try:
            if route == "health":
                self._json(200, {"status": "ok"})
            elif route == "keys":
                self._json(200, {"keys": self.server.store.keys()})
            elif route == "kv":
                found, value = self.server.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            elif route == "invalid_key":
                self._error(400, "invalid key")
            else:
                self._error(404, "route not found")
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._error(500, "internal server error")

    def do_PUT(self) -> None:
        route, key = self._path()
        if route == "invalid_key":
            self._error(400, "invalid key")
            return
        if route != "kv":
            self._error(404, "route not found")
            return
        try:
            body = self._read_json()
            if not isinstance(body, dict) or not set(body).issubset({"value", "ttl_seconds"}) or "value" not in body:
                raise RequestError(400, "body must be an object containing value and optional ttl_seconds")
            ttl = body.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(400, "ttl_seconds must be finite and greater than zero")
            replaced = self.server.store.put(key, body["value"], ttl)  # type: ignore[arg-type]
            self._json(200 if replaced else 201, {"key": key, "value": body["value"]})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._error(500, "internal server error")

    def do_DELETE(self) -> None:
        route, key = self._path()
        if route == "invalid_key":
            self._error(400, "invalid key")
            return
        if route != "kv":
            self._error(404, "route not found")
            return
        try:
            if self.server.store.delete(key):  # type: ignore[arg-type]
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self._error(404, "key not found")
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._error(500, "internal server error")

    def _method_not_allowed(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        encoded = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

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
    except Exception as exc:
        print(f"startup failed: {exc}", file=sys.stderr)
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
