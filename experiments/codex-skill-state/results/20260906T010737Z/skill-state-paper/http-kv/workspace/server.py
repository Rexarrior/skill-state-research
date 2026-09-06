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
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024


class BadRequest(Exception):
    """An error that should be reported to an HTTP client."""

    def __init__(self, message: str, status: int = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.message = message
        self.status = status


def _reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON number: {value}")


class Store:
    def __init__(self, path: Path):
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
                document = json.load(source, parse_constant=_reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("data file has no entries object")

            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError("invalid entry in data file")
                if set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid entry shape in data file")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiry in data file")
                if self._live(entry, now):
                    loaded[key] = entry
            self.entries = loaded
            if len(loaded) != len(raw_entries):
                self._persist_locked()
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        document = {"version": 1, "entries": self.entries}
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=parent, prefix=f".{self.path.name}.",
                suffix=".tmp", delete=False
            ) as target:
                temporary = target.name
                json.dump(document, target, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":"), sort_keys=True)
                target.write("\n")
                target.flush()
                os.fsync(target.fileno())
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
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            if self._purge_locked():
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_locked():
                self._persist_locked()
            return sorted(self.entries)

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked()
            existed = key in self.entries
            previous = self.entries.get(key)
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl is None else time.time() + ttl,
            }
            try:
                self._persist_locked()
            except Exception:
                if previous is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = previous
                raise
            return existed

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked()
            if key not in self.entries:
                return False
            previous = self.entries.pop(key)
            try:
                self._persist_locked()
            except Exception:
                self.entries[key] = previous
                raise
            return True


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" %
                         (self.address_string(), self.log_date_time_string(), fmt % args))

    def _json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False,
                             separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _path(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            raise BadRequest("query strings and fragments are not supported")
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if not parsed.path.startswith(prefix):
            raise BadRequest("route not found", HTTPStatus.NOT_FOUND)
        component = parsed.path[len(prefix):]
        if not component or "/" in component:
            raise BadRequest("key must be non-empty and must not contain '/'", HTTPStatus.BAD_REQUEST)
        try:
            key = unquote_to_bytes(component).decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError) as exc:
            raise BadRequest("key must be valid URL-encoded UTF-8") from exc
        if not key or "/" in key:
            raise BadRequest("key must be non-empty and must not contain '/'", HTTPStatus.BAD_REQUEST)
        return "kv", key

    def _read_json(self) -> Any:
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            raise BadRequest("Content-Length is required", HTTPStatus.LENGTH_REQUIRED)
        try:
            length = int(content_length)
        except ValueError as exc:
            raise BadRequest("invalid Content-Length") from exc
        if length < 0:
            raise BadRequest("invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            raise BadRequest("request body exceeds 1 MiB", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        body = self.rfile.read(length)
        try:
            return json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise BadRequest("malformed JSON") from exc

    def _dispatch(self, method: str) -> None:
        try:
            route, key = self._path()
            allowed = {
                "health": {"GET"},
                "keys": {"GET"},
                "kv": {"GET", "PUT", "DELETE"},
            }[route]
            if method not in allowed:
                self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
                self.send_header("Allow", ", ".join(sorted(allowed)))
                payload = b'{"error":"method not allowed"}'
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            if route == "health":
                self._json(HTTPStatus.OK, {"status": "ok"})
            elif route == "keys":
                self._json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            elif method == "GET":
                found, value = self.server.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            elif method == "DELETE":
                if self.server.store.delete(key):  # type: ignore[arg-type]
                    self.send_response(HTTPStatus.NO_CONTENT)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
            else:
                payload = self._read_json()
                if not isinstance(payload, dict) or "value" not in payload:
                    raise BadRequest("body must be an object containing 'value'")
                if set(payload) - {"value", "ttl_seconds"}:
                    raise BadRequest("body contains unsupported fields")
                ttl = payload.get("ttl_seconds")
                if ttl is not None and (
                    isinstance(ttl, bool)
                    or not isinstance(ttl, (int, float))
                    or not math.isfinite(ttl)
                    or ttl <= 0
                ):
                    raise BadRequest("ttl_seconds must be a finite number greater than zero")
                replaced = self.server.store.put(key, payload["value"], ttl)  # type: ignore[arg-type]
                self._json(HTTPStatus.OK if replaced else HTTPStatus.CREATED,
                           {"key": key, "value": payload["value"]})
        except BadRequest as exc:
            self._error(exc.status, exc.message)
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "internal server error")

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
    except (OSError, RuntimeError) as exc:
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
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
