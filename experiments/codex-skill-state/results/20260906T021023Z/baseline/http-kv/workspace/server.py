#!/usr/bin/env python3
"""A small, persistent HTTP key-value service."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
INVALID_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StorageError(RuntimeError):
    """Raised when durable state cannot be read or written."""


class PersistentStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return

        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise StorageError(f"cannot read data file {self.path}: {exc}") from exc

        if (
            not isinstance(document, dict)
            or document.get("version") != 1
            or not isinstance(document.get("entries"), dict)
        ):
            raise StorageError(f"invalid data file format: {self.path}")

        now = time.time()
        loaded: dict[str, dict[str, Any]] = {}
        for key, entry in document["entries"].items():
            if not isinstance(key, str) or not key or "/" in key:
                raise StorageError(f"invalid key in data file: {key!r}")
            if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                raise StorageError(f"invalid entry for key {key!r}")
            expires_at = entry["expires_at"]
            if expires_at is not None and (
                isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or (isinstance(expires_at, float) and not math.isfinite(expires_at))
            ):
                raise StorageError(f"invalid expiry for key {key!r}")
            if expires_at is None or expires_at > now:
                loaded[key] = entry

        self._entries = loaded
        # Rewrite after loading if expired records were found. This guarantees
        # that a later restart cannot resurrect stale on-disk state.
        if len(loaded) != len(document["entries"]):
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    @staticmethod
    def _expired(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is not None and expires_at <= now

    def _prune_locked(self, now: float) -> bool:
        expired = [
            key for key, entry in self._entries.items() if self._expired(entry, now)
        ]
        for key in expired:
            del self._entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as destination:
                    json.dump(
                        {"version": 1, "entries": self._entries},
                        destination,
                        ensure_ascii=True,
                        allow_nan=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                    destination.write("\n")
                    destination.flush()
                    os.fsync(destination.fileno())
                os.replace(temporary_name, self.path)
                self._sync_directory(parent)
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except (OSError, ValueError) as exc:
            raise StorageError(f"cannot persist data file {self.path}: {exc}") from exc

    @staticmethod
    def _sync_directory(parent: Path) -> None:
        if not hasattr(os, "O_DIRECTORY"):
            return
        directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self._lock:
            now = time.time()
            self._prune_locked(now)
            existed = key in self._entries
            previous = self._entries.get(key)
            if ttl_seconds is None:
                expires_at = None
            else:
                try:
                    expires_at = now + ttl_seconds
                except OverflowError:
                    # Arbitrarily large JSON integers are still finite numbers.
                    # This timestamp is far beyond any practical wall-clock time.
                    expires_at = sys.float_info.max
            self._entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StorageError:
                if previous is None:
                    del self._entries[key]
                else:
                    self._entries[key] = previous
                raise
            return existed

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            if self._expired(entry, time.time()):
                del self._entries[key]
                try:
                    self._persist_locked()
                except StorageError as exc:
                    print(exc, file=sys.stderr, flush=True)
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return False
            if self._expired(entry, time.time()):
                del self._entries[key]
                try:
                    self._persist_locked()
                except StorageError as exc:
                    print(exc, file=sys.stderr, flush=True)
                return False
            del self._entries[key]
            try:
                self._persist_locked()
            except StorageError:
                self._entries[key] = entry
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            if self._prune_locked(time.time()):
                try:
                    self._persist_locked()
                except StorageError as exc:
                    print(exc, file=sys.stderr, flush=True)
            return sorted(self._entries)

    def compact(self) -> None:
        with self._lock:
            self._prune_locked(time.time())
            self._persist_locked()


class KVHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: PersistentStore) -> None:
        self.store = store
        super().__init__(address, KVRequestHandler)


class KVRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"

    @property
    def store(self) -> PersistentStore:
        return self.server.store  # type: ignore[attr-defined, no-any-return]

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(10)

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

    def __getattr__(self, name: str) -> Any:
        # BaseHTTPRequestHandler otherwise emits its built-in HTML 501 page for
        # unrecognised verbs. Route every syntactically valid HTTP method
        # through the JSON router instead.
        if name.startswith("do_"):
            return self._dispatch
        raise AttributeError(name)

    def _dispatch(self) -> None:
        path = urlsplit(self.path).path

        if path == "/health":
            if self.command != "GET":
                self._method_not_allowed("GET")
            else:
                self._send_json(HTTPStatus.OK, {"status": "ok"})
            return

        if path == "/v1/keys":
            if self.command != "GET":
                self._method_not_allowed("GET")
            else:
                self._send_json(HTTPStatus.OK, {"keys": self.store.keys()})
            return

        if path.startswith(KEY_PREFIX):
            try:
                key = self._decode_key(path[len(KEY_PREFIX) :])
            except ValueError as exc:
                self._send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return
            if self.command == "GET":
                self._get_key(key)
            elif self.command == "PUT":
                self._put_key(key)
            elif self.command == "DELETE":
                self._delete_key(key)
            else:
                self._method_not_allowed("GET, PUT, DELETE")
            return

        self._send_error(HTTPStatus.NOT_FOUND, "unknown route")

    @staticmethod
    def _decode_key(encoded: str) -> str:
        if not encoded:
            raise ValueError("key must not be empty")
        if "/" in encoded or INVALID_PERCENT_ESCAPE.search(encoded):
            raise ValueError("invalid key")
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("key must be valid UTF-8") from exc
        if not key or "/" in key:
            raise ValueError("invalid key")
        return key

    def _read_json_object(self) -> dict[str, Any] | None:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            self._send_error(
                HTTPStatus.BAD_REQUEST, "transfer-encoded bodies are not supported"
            )
            return None

        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._send_error(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            return None
        try:
            length = int(content_length, 10)
        except ValueError:
            self._send_error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length < 0:
            self._send_error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body too large")
            return None

        try:
            raw_body = self.rfile.read(length)
        except OSError:
            self.close_connection = True
            self._send_error(HTTPStatus.BAD_REQUEST, "could not read request body")
            return None
        if len(raw_body) != length:
            self.close_connection = True
            self._send_error(HTTPStatus.BAD_REQUEST, "incomplete request body")
            return None
        try:
            body = json.loads(
                raw_body.decode("utf-8"), parse_constant=PersistentStore._reject_constant
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._send_error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return None
        if not isinstance(body, dict):
            self._send_error(HTTPStatus.BAD_REQUEST, "request body must be a JSON object")
            return None
        return body

    def _put_key(self, key: str) -> None:
        body = self._read_json_object()
        if body is None:
            return
        if "value" not in body or not set(body).issubset({"value", "ttl_seconds"}):
            self._send_error(
                HTTPStatus.BAD_REQUEST,
                "body must contain value and optional ttl_seconds only",
            )
            return

        ttl = body.get("ttl_seconds")
        if "ttl_seconds" in body and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or (isinstance(ttl, float) and not math.isfinite(ttl))
            or ttl <= 0
        ):
            self._send_error(
                HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero"
            )
            return

        try:
            replaced = self.store.put(key, body["value"], ttl)
        except (StorageError, OverflowError) as exc:
            self.log_error("persistence failure: %s", exc)
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not persist value")
            return
        status = HTTPStatus.OK if replaced else HTTPStatus.CREATED
        self._send_json(status, {"key": key, "value": body["value"]})

    def _get_key(self, key: str) -> None:
        found, value = self.store.get(key)
        if not found:
            self._send_error(HTTPStatus.NOT_FOUND, "key not found")
            return
        self._send_json(HTTPStatus.OK, {"key": key, "value": value})

    def _delete_key(self, key: str) -> None:
        try:
            deleted = self.store.delete(key)
        except StorageError as exc:
            self.log_error("persistence failure: %s", exc)
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not persist deletion")
            return
        if not deleted:
            self._send_error(HTTPStatus.NOT_FOUND, "key not found")
            return
        self._send_json(HTTPStatus.NO_CONTENT, None)

    def _method_not_allowed(self, allowed: str) -> None:
        # An unsupported method may carry an unread body. Closing the connection
        # prevents those bytes from being interpreted as another request.
        self.close_connection = True
        self._send_error(
            HTTPStatus.METHOD_NOT_ALLOWED,
            "method not allowed",
            extra_headers={"Allow": allowed, "Connection": "close"},
        )

    def _send_error(
        self,
        status: HTTPStatus,
        message: str,
        *,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self._send_json(status, {"error": message}, extra_headers=extra_headers)

    def _send_json(
        self,
        status: HTTPStatus,
        payload: Any,
        *,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = b""
        if status != HTTPStatus.NO_CONTENT:
            body = json.dumps(
                payload, ensure_ascii=True, allow_nan=False, separators=(",", ":")
            ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] " + format % args,
            file=sys.stderr,
            flush=True,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True, type=Path)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = PersistentStore(args.data)
        server = KVHTTPServer((args.host, args.port), store)
    except (OSError, StorageError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr, flush=True)
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
    exit_code = 0
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        try:
            store.compact()
        except StorageError as exc:
            print(f"shutdown persistence failed: {exc}", file=sys.stderr, flush=True)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
