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
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024
BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class Store:
    """Thread-safe store whose committed state always matches the data file."""

    def __init__(self, data_path: Path) -> None:
        self.path = data_path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entries: dict[str, dict[str, Any]], now: float) -> dict[str, dict[str, Any]]:
        return {
            key: record
            for key, record in entries.items()
            if record["expires_at"] is None or record["expires_at"] > now
        }

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle)
            raw_entries = document.get("entries") if isinstance(document, dict) else None
            if not isinstance(raw_entries, dict):
                raise ValueError("root must contain an 'entries' object")
            loaded: dict[str, dict[str, Any]] = {}
            for key, record in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid persisted key")
                if not isinstance(record, dict) or set(record) != {"value", "expires_at"}:
                    raise ValueError("invalid persisted entry")
                expires = record["expires_at"]
                if expires is not None and (
                    isinstance(expires, bool)
                    or not isinstance(expires, (int, float))
                    or not math.isfinite(expires)
                ):
                    raise ValueError("invalid persisted expiration")
                loaded[key] = {"value": record["value"], "expires_at": expires}
            live = self._live(loaded, time.time())
            self.entries = live
            if len(live) != len(loaded):
                self._persist(live)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        temporary: str | None = None
        try:
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    {"entries": entries},
                    handle,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                )
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
                # Directory fsync is unavailable on some platforms; replacement
                # itself is still atomic.
                pass
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def _purge_locked(self) -> None:
        live = self._live(self.entries, time.time())
        if len(live) != len(self.entries):
            self._persist(live)
            self.entries = live

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked()
            created = key not in self.entries
            updated = dict(self.entries)
            updated[key] = {
                "value": value,
                "expires_at": None if ttl is None else time.time() + ttl,
            }
            self._persist(updated)
            self.entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._purge_locked()
            record = self.entries.get(key)
            return (False, None) if record is None else (True, record["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked()
            if key not in self.entries:
                return False
            updated = dict(self.entries)
            del updated[key]
            self._persist(updated)
            self.entries = updated
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._purge_locked()
            return sorted(self.entries)


class KVServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = False

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        super().__init__(address, RequestHandler)
        self.store = store


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def _send_json(self, status: int, payload: Any | None = None) -> None:
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _parsed_path(self) -> tuple[str, str | None] | None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return None
        path = parsed.path
        if path in ("/health", "/v1/keys"):
            return path, None
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix):]
        if not encoded:
            return "invalid-key", None
        if "/" in encoded or BAD_PERCENT_ESCAPE.search(encoded):
            return "invalid-key", None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            return "invalid-key", None
        if not key or "/" in key:
            return "invalid-key", None
        return "/v1/kv", key

    def _route(self) -> tuple[str, str | None] | None:
        route = self._parsed_path()
        if route == ("invalid-key", None):
            self._error(400, "invalid key")
            return None
        if route is None:
            self._error(404, "route not found")
            return None
        return route

    def _read_json_body(self) -> Any:
        if self.headers.get("Transfer-Encoding"):
            raise RequestError(400, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(400, "Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError:
            raise RequestError(400, "invalid Content-Length") from None
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            return json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise RequestError(400, "malformed JSON") from None

    def do_GET(self) -> None:
        route = self._route()
        if route is None:
            return
        path, key = route
        if path == "/health":
            self._send_json(200, {"status": "ok"})
        elif path == "/v1/keys":
            try:
                self._send_json(200, {"keys": self.server.store.keys()})
            except (OSError, ValueError) as exc:
                self.log_error("persistence error: %s", exc)
                self._error(500, "persistence failure")
        elif path == "/v1/kv":
            try:
                found, value = self.server.store.get(key or "")
            except (OSError, ValueError) as exc:
                self.log_error("persistence error: %s", exc)
                self._error(500, "persistence failure")
                return
            if found:
                self._send_json(200, {"key": key, "value": value})
            else:
                self._error(404, "key not found")
        else:
            self._method_not_allowed()

    def do_PUT(self) -> None:
        route = self._route()
        if route is None:
            return
        path, key = route
        if path != "/v1/kv":
            self._method_not_allowed()
            return
        try:
            document = self._read_json_body()
            if not isinstance(document, dict):
                raise RequestError(400, "body must be a JSON object")
            if "value" not in document or not set(document).issubset({"value", "ttl_seconds"}):
                raise RequestError(400, "body must contain value and optional ttl_seconds")
            ttl = document.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(400, "ttl_seconds must be a finite number greater than zero")
            created = self.server.store.put(key or "", document["value"], ttl)
            self._send_json(201 if created else 200, {"key": key, "value": document["value"]})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except (OSError, ValueError) as exc:
            self.log_error("persistence error: %s", exc)
            self._error(500, "persistence failure")

    def do_DELETE(self) -> None:
        route = self._route()
        if route is None:
            return
        path, key = route
        if path != "/v1/kv":
            self._method_not_allowed()
            return
        try:
            deleted = self.server.store.delete(key or "")
        except (OSError, ValueError) as exc:
            self.log_error("persistence error: %s", exc)
            self._error(500, "persistence failure")
            return
        if deleted:
            self._send_json(204)
        else:
            self._error(404, "key not found")

    def _method_not_allowed(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        body = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _unsupported(self) -> None:
        route = self._route()
        if route is not None:
            self._method_not_allowed()

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        self.status = status
        self.message = message
        super().__init__(message)


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
        server = KVServer((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop_server(signum: int, frame: Any) -> None:
        del signum, frame
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop_server)
    signal.signal(signal.SIGINT, stop_server)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
