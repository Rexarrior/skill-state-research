#!/usr/bin/env python3
"""A small persistent HTTP key-value service."""

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
PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def decode_json(data: bytes) -> Any:
    try:
        text = data.decode("utf-8")
        return json.loads(text, parse_constant=_reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise RequestError(400, "malformed JSON") from exc


def validate_json_numbers(value: Any) -> None:
    """Reject numbers which parsed to infinity (for example, 1e9999)."""
    if isinstance(value, float) and not math.isfinite(value):
        raise RequestError(400, "JSON numbers must be finite")
    if isinstance(value, list):
        for item in value:
            validate_json_numbers(item)
    elif isinstance(value, dict):
        for item in value.values():
            validate_json_numbers(item)


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entries: dict[str, dict[str, Any]], now: float) -> dict[str, dict[str, Any]]:
        return {
            key: entry
            for key, entry in entries.items()
            if entry["expires_at"] is None or entry["expires_at"] > now
        }

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = self.path.read_text(encoding="utf-8")
            document = json.loads(raw, parse_constant=_reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            loaded = document.get("entries")
            if not isinstance(loaded, dict):
                raise ValueError("data-file entries must be an object")
            checked: dict[str, dict[str, Any]] = {}
            for key, entry in loaded.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid persisted key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid persisted entry")
                expires = entry["expires_at"]
                if expires is not None and (
                    isinstance(expires, bool)
                    or not isinstance(expires, (int, float))
                    or not math.isfinite(expires)
                ):
                    raise ValueError("invalid persisted expiration")
                validate_json_numbers(entry["value"])
                checked[key] = {"value": entry["value"], "expires_at": expires}
            self.entries = self._live(checked, time.time())
            if len(self.entries) != len(checked):
                self._persist(self.entries)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError, ValueError, RequestError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        live = self._live(entries, time.time())
        payload = json.dumps(
            {"version": 1, "entries": live},
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        temp_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=parent, prefix=f".{self.path.name}.", delete=False
            ) as stream:
                temp_name = stream.name
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, self.path)
            temp_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Directory fsync is unavailable on some platforms/filesystems.
                pass
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except FileNotFoundError:
                    pass

    def _prune_locked(self) -> None:
        live = self._live(self.entries, time.time())
        if len(live) != len(self.entries):
            self._persist(live)
            self.entries = live

    def put(self, key: str, value: Any, ttl: int | float | None) -> bool:
        with self.lock:
            self._prune_locked()
            created = key not in self.entries
            expires_at = None
            if ttl is not None:
                expires_at = time.time() + ttl
                if not math.isfinite(expires_at):
                    raise RequestError(400, "ttl_seconds is too large")
            updated = dict(self.entries)
            updated[key] = {"value": value, "expires_at": expires_at}
            self._persist(updated)
            self.entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._prune_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._prune_locked()
            if key not in self.entries:
                return False
            updated = dict(self.entries)
            del updated[key]
            self._persist(updated)
            self.entries = updated
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._prune_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _send(self, status: int, value: Any | None = None) -> None:
        body = b"" if value is None else json.dumps(
            value, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send(status, {"error": message})

    def _key(self, path: str) -> str | None:
        if not path.startswith(KEY_PREFIX):
            return None
        encoded = path[len(KEY_PREFIX) :]
        if not encoded or "/" in encoded or PERCENT_ESCAPE.search(encoded):
            raise RequestError(400, "invalid key")
        try:
            key = unquote(encoded, encoding="utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise RequestError(400, "key must be valid UTF-8") from exc
        if not key or "/" in key:
            raise RequestError(400, "invalid key")
        return key

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            raise RequestError(400, "Transfer-Encoding is not supported")
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
            # Consume the payload without retaining it.  Some clients send the
            # complete request before attempting to read the response; closing
            # immediately can otherwise surface as BrokenPipe instead of the
            # useful JSON 413 response.
            remaining = length
            previous_timeout = self.connection.gettimeout()
            try:
                self.connection.settimeout(5.0)
                while remaining:
                    chunk = self.rfile.read(min(remaining, 64 * 1024))
                    if not chunk:
                        self.close_connection = True
                        break
                    remaining -= len(chunk)
            except OSError:
                self.close_connection = True
            finally:
                self.connection.settimeout(previous_timeout)
            raise RequestError(413, "request body exceeds 1 MiB")
        data = self.rfile.read(length)
        if len(data) != length:
            raise RequestError(400, "incomplete request body")
        result = decode_json(data)
        validate_json_numbers(result)
        return result

    def _dispatch(self) -> None:
        try:
            path = urlsplit(self.path).path
            key = self._key(path)
            if self.command == "GET" and path == "/health":
                self._send(200, {"status": "ok"})
            elif self.command == "GET" and path == "/v1/keys":
                self._send(200, {"keys": self.server.store.keys()})
            elif key is not None and self.command == "GET":
                found, value = self.server.store.get(key)
                if found:
                    self._send(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            elif key is not None and self.command == "DELETE":
                if self.server.store.delete(key):
                    self._send(204)
                else:
                    self._error(404, "key not found")
            elif key is not None and self.command == "PUT":
                document = self._read_json()
                if not isinstance(document, dict) or not set(document).issubset({"value", "ttl_seconds"}) or "value" not in document:
                    raise RequestError(400, "body must be an object containing value and optional ttl_seconds")
                ttl = document.get("ttl_seconds")
                if ttl is not None and (
                    isinstance(ttl, bool)
                    or not isinstance(ttl, (int, float))
                    or not math.isfinite(ttl)
                    or ttl <= 0
                ):
                    raise RequestError(400, "ttl_seconds must be finite and greater than zero")
                created = self.server.store.put(key, document["value"], ttl)
                self._send(201 if created else 200, {"key": key, "value": document["value"]})
            elif key is not None or path in {"/health", "/v1/keys"}:
                self.send_response(405)
                self.send_header("Allow", "GET" if key is None else "GET, PUT, DELETE")
                body = b'{"error":"method not allowed"}'
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)
            else:
                self._error(404, "route not found")
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except (OSError, TypeError, ValueError) as exc:
            print(f"request failed: {exc}", file=sys.stderr)
            self._error(500, "internal server error")

    do_GET = _dispatch
    do_PUT = _dispatch
    do_DELETE = _dispatch
    do_POST = _dispatch
    do_PATCH = _dispatch
    do_HEAD = _dispatch
    do_OPTIONS = _dispatch


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
