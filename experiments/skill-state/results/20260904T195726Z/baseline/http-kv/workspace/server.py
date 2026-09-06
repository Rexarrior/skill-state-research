#!/usr/bin/env python3
"""Persistent, dependency-free HTTP key-value service."""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import string
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_SIZE = 1024 * 1024


class RequestError(Exception):
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
    def _expired(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is not None and expires_at <= now

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as data_file:
            document = json.load(
                data_file,
                parse_constant=self._reject_constant,
                parse_float=self._parse_float,
            )
        if not isinstance(document, dict) or document.get("version") != 1:
            raise ValueError("invalid data file format")
        entries = document.get("entries")
        if not isinstance(entries, dict):
            raise ValueError("invalid entries in data file")

        now = time.time()
        expired_found = False
        for key, entry in entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise ValueError("invalid key in data file")
            if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                raise ValueError("invalid entry in data file")
            expires_at = entry["expires_at"]
            if expires_at is not None and (
                isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or not math.isfinite(expires_at)
            ):
                raise ValueError("invalid expiry in data file")
            if self._expired(entry, now):
                expired_found = True
            else:
                self.entries[key] = entry
        if expired_found:
            self._persist()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    @staticmethod
    def _parse_float(value: str) -> float:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("JSON number is not finite")
        return number

    def _persist(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as data_file:
                json.dump(
                    {"version": 1, "entries": self.entries},
                    data_file,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                data_file.write("\n")
                data_file.flush()
                os.fsync(data_file.fileno())
            os.replace(temporary_name, self.path)
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except BaseException:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    def _remove_if_expired(self, key: str, now: float) -> bool:
        entry = self.entries.get(key)
        if entry is not None and self._expired(entry, now):
            del self.entries[key]
            self._persist()
            return True
        return False

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self.lock:
            self._remove_if_expired(key, time.time())
            created = key not in self.entries
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            previous = self.entries.get(key)
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist()
            except BaseException:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._remove_if_expired(key, time.time())
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._remove_if_expired(key, time.time())
            previous = self.entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist()
            except BaseException:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            now = time.time()
            expired = [key for key, entry in self.entries.items() if self._expired(entry, now)]
            if expired:
                for key in expired:
                    del self.entries[key]
                self._persist()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, document: Any) -> None:
        body = json.dumps(
            document, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _route_key(self) -> str | None:
        path = urlsplit(self.path).path
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded_key = path[len(prefix) :]
        if not encoded_key or "/" in encoded_key:
            raise RequestError(400, "invalid key")
        hex_digits = set(string.hexdigits)
        for index, character in enumerate(encoded_key):
            if character == "%" and (
                index + 2 >= len(encoded_key)
                or encoded_key[index + 1] not in hex_digits
                or encoded_key[index + 2] not in hex_digits
            ):
                raise RequestError(400, "invalid key encoding")
        try:
            key = unquote_to_bytes(encoded_key).decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError):
            raise RequestError(400, "invalid key encoding")
        if not key or "/" in key:
            raise RequestError(400, "invalid key")
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
        if length > MAX_BODY_SIZE:
            self.close_connection = True
            raise RequestError(413, "request body too large")
        body = self.rfile.read(length)
        if len(body) != length:
            raise RequestError(400, "incomplete request body")
        try:
            return json.loads(
                body.decode("utf-8"),
                parse_constant=Store._reject_constant,
                parse_float=Store._parse_float,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
            raise RequestError(400, "malformed JSON") from None

    def do_GET(self) -> None:
        try:
            path = urlsplit(self.path).path
            if path == "/health":
                self._send_json(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._send_json(200, {"keys": self.server.store.keys()})
                return
            key = self._route_key()
            if key is None:
                self._error(404, "route not found")
                return
            found, value = self.server.store.get(key)
            if not found:
                self._error(404, "key not found")
                return
            self._send_json(200, {"key": key, "value": value})
        except RequestError as error:
            self._error(error.status, error.message)
        except OSError:
            self.log_error("storage operation failed")
            traceback.print_exc(file=os.sys.stderr)
            self._error(500, "internal server error")

    def do_PUT(self) -> None:
        try:
            key = self._route_key()
            if key is None:
                self._error(404, "route not found")
                return
            document = self._read_json()
            if not isinstance(document, dict) or "value" not in document:
                raise RequestError(400, "body must be an object containing value")
            if not set(document).issubset({"value", "ttl_seconds"}):
                raise RequestError(400, "body contains unknown fields")
            ttl = document.get("ttl_seconds")
            if "ttl_seconds" in document and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestError(400, "ttl_seconds must be a finite number greater than zero")
            created = self.server.store.put(key, document["value"], ttl)
            self._send_json(201 if created else 200, {"key": key, "value": document["value"]})
        except RequestError as error:
            self._error(error.status, error.message)
        except (OSError, TypeError, ValueError):
            self.log_error("storage operation failed")
            traceback.print_exc(file=os.sys.stderr)
            self._error(500, "internal server error")

    def do_DELETE(self) -> None:
        try:
            key = self._route_key()
            if key is None:
                self._error(404, "route not found")
                return
            if not self.server.store.delete(key):
                self._error(404, "key not found")
                return
            self._send_empty(204)
        except RequestError as error:
            self._error(error.status, error.message)
        except OSError:
            self.log_error("storage operation failed")
            traceback.print_exc(file=os.sys.stderr)
            self._error(500, "internal server error")

    def _method_not_allowed(self) -> None:
        self.close_connection = True
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
    do_OPTIONS = _method_not_allowed
    do_HEAD = _method_not_allowed


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
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"failed to start server: {error}", file=os.sys.stderr)
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
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
