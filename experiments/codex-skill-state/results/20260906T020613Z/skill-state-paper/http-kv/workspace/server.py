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
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
_BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class PersistenceError(RuntimeError):
    """Raised when durable state cannot be read or written."""


class Store:
    def __init__(self, data_path: Path) -> None:
        self.data_path = data_path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.data_path.exists():
            return
        try:
            with self.data_path.open("r", encoding="utf-8") as stream:
                document = json.load(stream, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("expected a version 1 object")
            entries = document.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("'entries' must be an object")

            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("stored key is invalid")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("stored entry is invalid")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("stored expiration is invalid")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise PersistenceError(f"cannot load data file {self.data_path}: {exc}") from exc

        now = time.time()
        self._entries = {
            key: entry for key, entry in loaded.items() if self._is_live(entry, now)
        }
        if len(self._entries) != len(loaded):
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist_locked(self) -> None:
        parent = self.data_path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.data_path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(
                        {"version": 1, "entries": self._entries},
                        stream,
                        ensure_ascii=False,
                        separators=(",", ":"),
                        allow_nan=False,
                    )
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary_name, self.data_path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    # The replacement itself is atomic; not every platform permits
                    # fsync on a directory.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except (OSError, TypeError, ValueError) as exc:
            raise PersistenceError(f"cannot persist data file {self.data_path}: {exc}") from exc

    def _remove_expired_locked(self, now: float) -> bool:
        expired = [
            key for key, entry in self._entries.items() if not self._is_live(entry, now)
        ]
        for key in expired:
            del self._entries[key]
        if expired:
            self._persist_locked()
        return bool(expired)

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self._lock:
            now = time.time()
            old_entry = self._entries.get(key)
            created = old_entry is None or not self._is_live(old_entry, now)
            new_entry = {
                "value": value,
                "expires_at": None if ttl_seconds is None else now + ttl_seconds,
            }
            self._entries[key] = new_entry
            try:
                self._persist_locked()
            except PersistenceError:
                if old_entry is None:
                    del self._entries[key]
                else:
                    self._entries[key] = old_entry
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            if not self._is_live(entry, time.time()):
                del self._entries[key]
                self._persist_locked()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return False
            if not self._is_live(entry, time.time()):
                del self._entries[key]
                self._persist_locked()
                return False
            del self._entries[key]
            try:
                self._persist_locked()
            except PersistenceError:
                self._entries[key] = entry
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            self._remove_expired_locked(time.time())
            return sorted(self._entries)


class KVHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVHTTPServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - - [{self.log_date_time_string()}] " + format % args,
            file=sys.stderr,
            flush=True,
        )

    def _send_json(self, status: int, body: Any) -> None:
        encoded = json.dumps(
            body, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        # Keep parser-level HTTP errors JSON as well.
        del explain
        self._error(code, message or self.responses.get(code, ("Error",))[0])

    def _path(self) -> str | None:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self._error(400, "invalid request target")
            return None
        if parsed.query or parsed.fragment:
            self._error(404, "route not found")
            return None
        return parsed.path

    def _key_from_path(self, path: str) -> str | None:
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded_key = path[len(prefix) :]
        if _BAD_PERCENT_ESCAPE.search(encoded_key):
            self._error(400, "invalid key encoding")
            return ""
        try:
            raw_key = unquote_to_bytes(encoded_key)
            key = raw_key.decode("utf-8", errors="strict")
        except (UnicodeEncodeError, UnicodeDecodeError):
            self._error(400, "key must be valid UTF-8")
            return ""
        if not key or "/" in key:
            self._error(400, "key must be non-empty and must not contain '/'")
            return ""
        return key

    def _read_json_body(self) -> Any:
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            raise RequestProblem(411, "Content-Length is required")
        try:
            length = int(content_length, 10)
        except ValueError as exc:
            raise RequestProblem(400, "invalid Content-Length") from exc
        if length < 0:
            raise RequestProblem(400, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            raise RequestProblem(413, "request body exceeds 1 MiB")
        media_type = self.headers.get_content_type()
        if media_type != "application/json":
            raise RequestProblem(415, "Content-Type must be application/json")
        try:
            raw_body = self.rfile.read(length)
        except (OSError, TimeoutError) as exc:
            raise RequestProblem(400, "could not read request body") from exc
        if len(raw_body) != length:
            raise RequestProblem(400, "incomplete request body")
        try:
            return json.loads(raw_body, parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise RequestProblem(400, "malformed JSON") from exc

    def do_GET(self) -> None:
        path = self._path()
        if path is None:
            return
        try:
            if path == "/health":
                self._send_json(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._send_json(200, {"keys": self.server.store.keys()})
                return
            key = self._key_from_path(path)
            if key is None:
                self._error(404, "route not found")
            elif key:
                found, value = self.server.store.get(key)
                if found:
                    self._send_json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
        except PersistenceError as exc:
            self.log_error("%s", exc)
            self._error(500, "persistence failure")

    def do_PUT(self) -> None:
        path = self._path()
        if path is None:
            return
        key = self._key_from_path(path)
        if key is None:
            self._error(404, "route not found")
            return
        if not key:
            return
        try:
            body = self._read_json_body()
            if not isinstance(body, dict) or isinstance(body, bool):
                raise RequestProblem(400, "body must be a JSON object")
            if "value" not in body or not set(body).issubset({"value", "ttl_seconds"}):
                raise RequestProblem(
                    400, "body must contain 'value' and optional 'ttl_seconds' only"
                )
            ttl = body.get("ttl_seconds")
            if ttl is not None and (
                isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
                or not math.isfinite(ttl)
                or ttl <= 0
            ):
                raise RequestProblem(400, "ttl_seconds must be finite and greater than zero")
            created = self.server.store.put(key, body["value"], ttl)
            self._send_json(201 if created else 200, {"key": key, "value": body["value"]})
        except RequestProblem as exc:
            self._error(exc.status, exc.message)
        except PersistenceError as exc:
            self.log_error("%s", exc)
            self._error(500, "persistence failure")

    def do_DELETE(self) -> None:
        path = self._path()
        if path is None:
            return
        key = self._key_from_path(path)
        if key is None:
            self._error(404, "route not found")
            return
        if not key:
            return
        try:
            if self.server.store.delete(key):
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self._error(404, "key not found")
        except PersistenceError as exc:
            self.log_error("%s", exc)
            self._error(500, "persistence failure")

    def _method_not_allowed(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_TRACE = _method_not_allowed
    do_CONNECT = _method_not_allowed


class RequestProblem(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="address to bind")
    parser.add_argument("--port", required=True, type=int, help="port to bind (0 for any)")
    parser.add_argument("--data", required=True, type=Path, help="JSON data file")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = Store(args.data)
        server = KVHTTPServer((args.host, args.port), store)
    except (OSError, PersistenceError) as exc:
        print(f"fatal: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def request_shutdown(signum: int, frame: Any) -> None:
        del signum, frame
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)

    actual_port = server.server_address[1]
    print(f"LISTENING {actual_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
