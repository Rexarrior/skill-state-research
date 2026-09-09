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
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024
API_PREFIX = "/v1/kv/"


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Store:
    """Lock-protected store whose mutations are persisted atomically."""

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
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except FileNotFoundError:
            return
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("entries"), dict):
            raise RuntimeError(f"invalid data file format: {self.path}")

        now = time.time()
        dirty = False
        for key, entry in raw["entries"].items():
            if not isinstance(key, str) or not isinstance(entry, dict) or "value" not in entry:
                raise RuntimeError(f"invalid data file format: {self.path}")
            expires_at = entry.get("expires_at")
            if expires_at is not None and (isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)) or not math.isfinite(expires_at)):
                raise RuntimeError(f"invalid data file format: {self.path}")
            normalized = {"value": entry["value"], "expires_at": expires_at}
            if self._live(normalized, now):
                self.entries[key] = normalized
            else:
                dirty = True
        if dirty:
            self._persist_locked()

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "entries": self.entries}
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            # Also make the directory entry durable where the platform permits it.
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def _purge_locked(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        if expired:
            self._persist_locked()
        return bool(expired)

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._purge_locked(now)
            created = key not in self.entries
            expires_at = None if ttl is None else now + ttl
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except BaseException:
                # Reloading is unnecessary: retain a coherent in-memory state but
                # let the handler report that the durable mutation failed.
                raise
            return created

    def get(self, key: str) -> Any:
        with self.lock:
            self._purge_locked(time.time())
            if key not in self.entries:
                raise KeyError(key)
            return self.entries[key]["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked(time.time())
            if key not in self.entries:
                return False
            del self.entries[key]
            self._persist_locked()
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._purge_locked(time.time())
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)

    def handle_error(self, request: Any, client_address: Any) -> None:
        print(f"error handling request from {client_address}", file=sys.stderr)
        super().handle_error(request, client_address)


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
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _path(self) -> str:
        try:
            parsed = urlsplit(self.path)
        except ValueError as exc:
            raise RequestError(400, "invalid request target") from exc
        if parsed.query or parsed.fragment:
            raise RequestError(404, "route not found")
        return parsed.path

    def _key(self, path: str) -> str:
        if not path.startswith(API_PREFIX):
            raise RequestError(404, "route not found")
        encoded = path[len(API_PREFIX):]
        if not encoded or "/" in encoded:
            raise RequestError(400, "invalid key")
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RequestError(400, "key must be valid UTF-8") from exc
        if not key or "/" in key:
            raise RequestError(400, "invalid key")
        return key

    def _body(self) -> dict[str, Any]:
        transfer = self.headers.get("Transfer-Encoding")
        if transfer:
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
            # Consume the request in bounded chunks before replying. Closing the
            # socket while a client is still uploading can turn the intended
            # JSON 413 response into a BrokenPipeError on the client side.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise RequestError(413, "request body too large")
        raw = self.rfile.read(length)
        try:
            body = json.loads(
                raw,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError(f"invalid JSON constant: {value}")
                ),
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise RequestError(400, "malformed JSON") from exc
        if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
            raise RequestError(400, "body must be an object with value and optional ttl_seconds")
        return body

    def _dispatch(self) -> None:
        path = self._path()
        method = self.command
        known = path == "/health" or path == "/v1/keys" or path.startswith(API_PREFIX)
        if not known:
            raise RequestError(404, "route not found")

        if path == "/health":
            if method != "GET":
                raise RequestError(405, "method not allowed")
            self._json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            if method != "GET":
                raise RequestError(405, "method not allowed")
            self._json(200, {"keys": self.server.store.keys()})
            return

        key = self._key(path)
        if method == "GET":
            try:
                value = self.server.store.get(key)
            except KeyError:
                raise RequestError(404, "key not found")
            self._json(200, {"key": key, "value": value})
        elif method == "PUT":
            body = self._body()
            ttl = body.get("ttl_seconds")
            if ttl is not None:
                if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0:
                    raise RequestError(400, "ttl_seconds must be a finite number greater than zero")
                ttl = float(ttl)
            created = self.server.store.put(key, body["value"], ttl)
            self._json(201 if created else 200, {"key": key, "value": body["value"]})
        elif method == "DELETE":
            if self.server.store.delete(key):
                self._empty(204)
            else:
                raise RequestError(404, "key not found")
        else:
            raise RequestError(405, "method not allowed")

    def _handle(self) -> None:
        try:
            self._dispatch()
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except (OSError, TypeError, ValueError) as exc:
            print(f"request failed: {exc}", file=sys.stderr)
            self._error(500, "internal server error")

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        """Keep parser and unknown-method failures in the JSON API contract."""
        if code == 501:
            code = 405
            message = "method not allowed"
        self._error(code, message or self.responses.get(code, ("error",))[0])

    do_GET = _handle
    do_PUT = _handle
    do_DELETE = _handle
    do_POST = _handle
    do_PATCH = _handle
    do_HEAD = _handle
    do_OPTIONS = _handle


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
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
        print(f"server startup failed: {exc}", file=sys.stderr)
        return 1

    def stop(signum: int, frame: Any) -> None:
        # shutdown() must run outside the serve_forever thread.
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
