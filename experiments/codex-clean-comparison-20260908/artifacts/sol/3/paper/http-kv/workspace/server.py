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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


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

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
            if not isinstance(raw, dict) or raw.get("version") != 1:
                raise ValueError("unsupported data-file format")
            entries = raw.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("invalid entries in data file")
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("invalid entry in data file")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiry in data file")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
            if self._purge_locked(time.time()):
                self._persist_locked()
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    def _purge_locked(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"version": 1, "entries": self.entries}, handle, ensure_ascii=False,
                          separators=(",", ":"), allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
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
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._purge_locked(now)
            created = key not in self.entries
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl is None else now + ttl,
            }
            self._persist_locked()
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if not self._live(entry, time.time()):
                del self.entries[key]
                self._persist_locked()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            now = time.time()
            purged = self._purge_locked(now)
            existed = key in self.entries
            if existed:
                del self.entries[key]
            if existed or purged:
                self._persist_locked()
            return existed

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_locked(time.time()):
                self._persist_locked()
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
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, error: ApiError) -> None:
        self._json(error.status, {"error": error.message})

    def _path(self) -> str:
        try:
            return urlsplit(self.path).path
        except ValueError as exc:
            raise ApiError(400, "invalid request path") from exc

    def _key(self, path: str) -> str:
        prefix = "/v1/kv/"
        encoded = path[len(prefix):]
        if not encoded or "/" in encoded:
            raise ApiError(400, "key must be non-empty and must not contain '/'")
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ApiError(400, "key must be valid UTF-8") from exc
        if not key or "/" in key:
            raise ApiError(400, "key must be non-empty and must not contain '/'")
        return key

    def _body(self) -> Any:
        transfer = self.headers.get("Transfer-Encoding")
        if transfer:
            raise ApiError(400, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise ApiError(411, "Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise ApiError(400, "invalid Content-Length") from exc
        if length < 0:
            raise ApiError(400, "invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            raise ApiError(413, "request body exceeds 1 MiB")
        data = self.rfile.read(length)
        try:
            return json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, "malformed JSON") from exc

    def _dispatch(self, method: str) -> None:
        path = self._path()
        if method == "GET" and path == "/health":
            self._json(200, {"status": "ok"})
            return
        if method == "GET" and path == "/v1/keys":
            self._json(200, {"keys": self.server.store.keys()})
            return
        if path.startswith("/v1/kv/"):
            key = self._key(path)
            if method == "GET":
                found, value = self.server.store.get(key)
                if not found:
                    raise ApiError(404, "key not found")
                self._json(200, {"key": key, "value": value})
                return
            if method == "DELETE":
                if not self.server.store.delete(key):
                    raise ApiError(404, "key not found")
                self._empty(204)
                return
            if method == "PUT":
                payload = self._body()
                if not isinstance(payload, dict) or "value" not in payload:
                    raise ApiError(400, "body must be an object containing 'value'")
                if set(payload) - {"value", "ttl_seconds"}:
                    raise ApiError(400, "body contains unknown fields")
                ttl = payload.get("ttl_seconds")
                if ttl is not None:
                    if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0:
                        raise ApiError(400, "ttl_seconds must be a finite number greater than zero")
                    ttl = float(ttl)
                try:
                    created = self.server.store.put(key, payload["value"], ttl)
                except (OSError, ValueError) as exc:
                    self.log_error("persistence failed: %s", exc)
                    raise ApiError(500, "could not persist data") from exc
                self._json(201 if created else 200, {"key": key, "value": payload["value"]})
                return
            raise ApiError(405, "method not allowed")
        known = path in {"/health", "/v1/keys"}
        if known:
            raise ApiError(405, "method not allowed")
        raise ApiError(404, "route not found")

    def _handle(self, method: str) -> None:
        try:
            self._dispatch(method)
        except ApiError as exc:
            self._error(exc)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.log_error("internal error: %s", exc)
            try:
                self._json(500, {"error": "internal server error"})
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_GET(self) -> None:
        self._handle("GET")

    def do_PUT(self) -> None:
        self._handle("PUT")

    def do_DELETE(self) -> None:
        self._handle("DELETE")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_PATCH(self) -> None:
        self._handle("PATCH")

    def do_HEAD(self) -> None:
        self._handle("HEAD")


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
        print(f"error: {exc}", file=sys.stderr)
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
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
