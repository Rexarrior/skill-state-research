#!/usr/bin/env python3
"""A small persistent HTTP JSON key-value service."""

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
PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


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
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            raw_entries = document.get("entries") if isinstance(document, dict) else None
            if not isinstance(raw_entries, dict):
                raise ValueError("top-level object must contain an entries object")
            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid key in data file")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid entry in data file")
                expires_at = entry["expires_at"]
                if expires_at is not None:
                    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
                        raise ValueError("invalid expiry in data file")
                    if not math.isfinite(expires_at):
                        raise ValueError("invalid expiry in data file")
                    if expires_at <= now:
                        continue
                # Validate that values remain representable as standards-compliant JSON.
                json.dumps(entry["value"], allow_nan=False)
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
            if len(loaded) != len(raw_entries):
                self._persist_locked()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(token: str) -> None:
        raise ValueError(f"invalid JSON constant {token}")

    def _purge_locked(self) -> bool:
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
        temporary_name: str | None = None
        try:
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            with os.fdopen(fd, "w", encoding="utf-8") as target:
                json.dump(
                    {"entries": self.entries},
                    target,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                target.write("\n")
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Directory fsync is unavailable on some supported filesystems.
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

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            purged = self._purge_locked()
            if purged:
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked()
            previous = self.entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist_locked()
            except Exception:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            purged = self._purge_locked()
            if purged:
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

    def do_GET(self) -> None:
        self._dispatch()

    def do_PUT(self) -> None:
        self._dispatch()

    def do_DELETE(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_PATCH(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch()

    def do_OPTIONS(self) -> None:
        self._dispatch()

    def _dispatch(self) -> None:
        try:
            parsed = urlsplit(self.path)
            if parsed.query or parsed.fragment:
                raise ApiError(404, "unknown route")
            path = parsed.path

            if path == "/health":
                self._require_method("GET")
                self._send_json(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._require_method("GET")
                self._send_json(200, {"keys": self.server.store.keys()})
                return
            if path.startswith(KEY_PREFIX):
                key = self._decode_key(path[len(KEY_PREFIX) :])
                if self.command == "GET":
                    found, value = self.server.store.get(key)
                    if not found:
                        raise ApiError(404, "key not found")
                    self._send_json(200, {"key": key, "value": value})
                    return
                if self.command == "DELETE":
                    if not self.server.store.delete(key):
                        raise ApiError(404, "key not found")
                    self._send_empty(204)
                    return
                if self.command == "PUT":
                    body = self._read_json_body()
                    if not isinstance(body, dict):
                        raise ApiError(400, "body must be a JSON object")
                    if "value" not in body or not set(body).issubset({"value", "ttl_seconds"}):
                        raise ApiError(400, "body must contain value and optional ttl_seconds")
                    ttl = body.get("ttl_seconds")
                    if ttl is not None:
                        if isinstance(ttl, bool) or not isinstance(ttl, (int, float)):
                            raise ApiError(400, "ttl_seconds must be a number")
                        if not math.isfinite(ttl) or ttl <= 0:
                            raise ApiError(400, "ttl_seconds must be finite and greater than zero")
                        ttl = float(ttl)
                    replaced = self.server.store.put(key, body["value"], ttl)
                    self._send_json(200 if replaced else 201, {"key": key, "value": body["value"]})
                    return
                self._method_not_allowed("GET, PUT, DELETE")
                return
            raise ApiError(404, "unknown route")
        except ApiError as exc:
            self._send_json(exc.status, {"error": exc.message})
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._send_json(500, {"error": "internal server error"})

    def _require_method(self, method: str) -> None:
        if self.command != method:
            self._method_not_allowed(method)

    def _method_not_allowed(self, allow: str) -> None:
        raise ApiError(405, f"method {self.command} not allowed")

    @staticmethod
    def _decode_key(encoded: str) -> str:
        if not encoded or "/" in encoded or PERCENT_ESCAPE.search(encoded):
            raise ApiError(400, "invalid key")
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ApiError(400, "key must be valid UTF-8") from exc
        if not key or "/" in key:
            raise ApiError(400, "invalid key")
        return key

    def _read_json_body(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            raise ApiError(400, "transfer encoding is not supported")
        length_text = self.headers.get("Content-Length")
        if length_text is None:
            raise ApiError(411, "Content-Length is required")
        try:
            length = int(length_text, 10)
        except ValueError as exc:
            raise ApiError(400, "invalid Content-Length") from exc
        if length < 0:
            raise ApiError(400, "invalid Content-Length")
        if length > MAX_BODY:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            raise ApiError(413, "request body exceeds 1 MiB")
        raw = self.rfile.read(length)
        if len(raw) != length:
            self.close_connection = True
            raise ApiError(400, "incomplete request body")
        try:
            return json.loads(raw.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise ApiError(400, "malformed JSON") from exc

    def _send_json(self, status: int, body: Any) -> None:
        payload = json.dumps(
            body, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - {format % args}",
            file=sys.stderr,
            flush=True,
        )


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
        print(f"startup failed: {exc}", file=sys.stderr, flush=True)
        return 1

    shutting_down = threading.Event()

    def stop(signum: int, frame: Any) -> None:
        del signum, frame
        if not shutting_down.is_set():
            shutting_down.set()
            # shutdown() must run outside the serve_forever() thread.
            threading.Thread(target=server.shutdown, daemon=True).start()

    old_term = signal.signal(signal.SIGTERM, stop)
    old_int = signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGINT, old_int)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
