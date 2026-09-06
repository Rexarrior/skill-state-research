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


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = self._load()
        with self.lock:
            if self._purge_expired(self.entries):
                self._write(self.entries)

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        with self.path.open("r", encoding="utf-8") as source:
            document = json.load(source, parse_constant=self._reject_constant)
        if not isinstance(document, dict) or not isinstance(document.get("entries"), dict):
            raise ValueError("data file has an invalid format")
        entries = document["entries"]
        for key, entry in entries.items():
            if (
                not isinstance(key, str)
                or not key
                or "/" in key
                or not isinstance(entry, dict)
                or set(entry) != {"value", "expires_at"}
                or not self._valid_expiry(entry["expires_at"])
            ):
                raise ValueError("data file has an invalid entry")
        return entries

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    @staticmethod
    def _valid_expiry(value: Any) -> bool:
        return value is None or (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
        )

    @staticmethod
    def _purge_expired(entries: dict[str, dict[str, Any]]) -> bool:
        now = time.time()
        expired = [
            key
            for key, entry in entries.items()
            if entry["expires_at"] is not None and entry["expires_at"] <= now
        ]
        for key in expired:
            del entries[key]
        return bool(expired)

    def _write(self, entries: dict[str, dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(
                    {"entries": entries}, output, ensure_ascii=False, separators=(",", ":")
                )
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            updated = dict(self.entries)
            self._purge_expired(updated)
            created = key not in updated
            updated[key] = {
                "value": value,
                "expires_at": None if ttl is None else time.time() + ttl,
            }
            self._write(updated)
            self.entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            updated = dict(self.entries)
            changed = self._purge_expired(updated)
            if changed:
                self._write(updated)
                self.entries = updated
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            updated = dict(self.entries)
            self._purge_expired(updated)
            if key not in updated:
                if updated != self.entries:
                    self._write(updated)
                    self.entries = updated
                return False
            del updated[key]
            self._write(updated)
            self.entries = updated
            return True

    def keys(self) -> list[str]:
        with self.lock:
            updated = dict(self.entries)
            if self._purge_expired(updated):
                self._write(updated)
                self.entries = updated
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _path(self) -> str | None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return None
        return parsed.path

    def _key(self, path: str) -> str | None:
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix) :]
        if not encoded or "/" in encoded:
            return None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError):
            return None
        return key if key and "/" not in key else None

    def _read_json(self) -> Any:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
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
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            return json.loads(body, parse_constant=Store._reject_constant)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            raise RequestError(400, "malformed JSON") from None

    def do_GET(self) -> None:
        path = self._path()
        try:
            if path == "/health":
                self._json(200, {"status": "ok"})
            elif path == "/v1/keys":
                self._json(200, {"keys": self.server.store.keys()})
            elif path is not None and path.startswith("/v1/kv/"):
                key = self._key(path)
                if key is None:
                    self._error(400, "invalid key")
                    return
                found, value = self.server.store.get(key)
                if found:
                    self._json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            else:
                self._error(404, "route not found")
        except OSError:
            self.log_error("persistence failure", exc_info=True)
            self._error(500, "persistence failure")

    def do_PUT(self) -> None:
        path = self._path()
        if path is None or not path.startswith("/v1/kv/"):
            self._error(404, "route not found")
            return
        key = self._key(path)
        if key is None:
            self._error(400, "invalid key")
            return
        try:
            payload = self._read_json()
            if not isinstance(payload, dict) or "value" not in payload or not set(payload) <= {
                "value",
                "ttl_seconds",
            }:
                raise RequestError(400, "body must contain value and optional ttl_seconds")
            ttl = payload.get("ttl_seconds")
            if ttl is not None and (
                not isinstance(ttl, (int, float))
                or isinstance(ttl, bool)
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(400, "ttl_seconds must be finite and greater than zero")
            created = self.server.store.put(key, payload["value"], ttl)
            self._json(201 if created else 200, {"key": key, "value": payload["value"]})
        except RequestError as error:
            self._error(error.status, error.message)
        except OSError:
            self.log_error("persistence failure", exc_info=True)
            self._error(500, "persistence failure")

    def do_DELETE(self) -> None:
        path = self._path()
        if path is None or not path.startswith("/v1/kv/"):
            self._error(404, "route not found")
            return
        key = self._key(path)
        if key is None:
            self._error(400, "invalid key")
            return
        try:
            if not self.server.store.delete(key):
                self._error(404, "key not found")
                return
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except OSError:
            self.log_error("persistence failure", exc_info=True)
            self._error(500, "persistence failure")

    def _method_not_allowed(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        body = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        self.status = status
        self.message = message


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), store)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"startup failed: {error}", file=sys.stderr)
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
