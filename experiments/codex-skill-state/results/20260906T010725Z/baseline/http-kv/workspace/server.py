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
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


MAX_BODY_BYTES = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
_BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(Exception):
    """Raised when persistent state cannot be read or written."""


class Store:
    """Thread-safe, JSON-backed key-value storage."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live_entries(
        entries: dict[str, dict[str, Any]], now: float | None = None
    ) -> dict[str, dict[str, Any]]:
        if now is None:
            now = time.time()
        return {
            key: entry
            for key, entry in entries.items()
            if entry["expires_at"] is None or entry["expires_at"] > now
        }

    @staticmethod
    def _validate_file(data: Any) -> dict[str, dict[str, Any]]:
        if not isinstance(data, dict) or set(data) != {"entries"}:
            raise StoreError("data file has an invalid top-level structure")
        raw_entries = data["entries"]
        if not isinstance(raw_entries, dict):
            raise StoreError("data file entries must be an object")

        entries: dict[str, dict[str, Any]] = {}
        for key, entry in raw_entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise StoreError("data file contains an invalid key")
            if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                raise StoreError(f"data file contains an invalid entry for {key!r}")
            expires_at = entry["expires_at"]
            if expires_at is not None:
                if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
                    raise StoreError(f"data file contains an invalid expiry for {key!r}")
                try:
                    valid_expiry = math.isfinite(expires_at)
                except (OverflowError, TypeError):
                    valid_expiry = False
                if not valid_expiry:
                    raise StoreError(f"data file contains an invalid expiry for {key!r}")
            entries[key] = {"value": entry["value"], "expires_at": expires_at}
        return entries

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                data = json.load(source, parse_constant=self._reject_constant)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise StoreError(f"cannot read data file {self.path}: {exc}") from exc

        entries = self._validate_file(data)
        live = self._live_entries(entries)
        self._entries = live
        if len(live) != len(entries):
            self._persist(live)

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number {value}")

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        if not parent.is_dir():
            raise StoreError(f"data directory does not exist: {parent}")

        temp_name: str | None = None
        try:
            fd, temp_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(
                    {"entries": entries},
                    output,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp_name, self.path)
            temp_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some filesystems do not support syncing directories.
                pass
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass

    def _prune_expired(self) -> None:
        live = self._live_entries(self._entries)
        if len(live) == len(self._entries):
            return
        self._entries = live
        try:
            self._persist(live)
        except StoreError as exc:
            # Expired values must remain absent even if cleanup cannot be saved.
            print(f"warning: {exc}", file=sys.stderr, flush=True)

    def put(self, key: str, value: Any, ttl_seconds: float | int | None) -> bool:
        with self._lock:
            self._prune_expired()
            created = key not in self._entries
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            updated = dict(self._entries)
            updated[key] = {"value": value, "expires_at": expires_at}
            self._persist(updated)
            self._entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            self._prune_expired()
            if key not in self._entries:
                return False, None
            return True, self._entries[key]["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            self._prune_expired()
            if key not in self._entries:
                return False
            updated = dict(self._entries)
            del updated[key]
            self._persist(updated)
            self._entries = updated
            return True

    def keys(self) -> list[str]:
        with self._lock:
            self._prune_expired()
            return sorted(self._entries)


class KVHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"
    sys_version = ""

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined,no-any-return]

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - {format_string % args}",
            file=sys.stderr,
            flush=True,
        )

    def send_error(
        self, code: int, message: str | None = None, explain: str | None = None
    ) -> None:
        """Keep errors generated by BaseHTTPRequestHandler JSON-formatted."""
        del explain
        if code == HTTPStatus.NOT_IMPLEMENTED:
            if hasattr(self, "path") and not self._route_exists():
                code = HTTPStatus.NOT_FOUND
                message = "route not found"
            else:
                code = HTTPStatus.METHOD_NOT_ALLOWED
                message = "method not allowed"
        if message is None:
            try:
                message = HTTPStatus(code).phrase.lower()
            except ValueError:
                message = "request failed"
        self._error(int(code), message)

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if getattr(self, "command", None) != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _key(self) -> tuple[str | None, str | None]:
        path = self._path()
        if not path.startswith(KEY_PREFIX):
            return None, None
        encoded = path[len(KEY_PREFIX) :]
        if not encoded:
            return None, "key must not be empty"
        if "/" in encoded:
            return None, "key must not contain '/'"
        if _BAD_PERCENT_ESCAPE.search(encoded):
            return None, "key has invalid percent encoding"
        try:
            key = unquote(encoded, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return None, "key must be valid UTF-8"
        if not key:
            return None, "key must not be empty"
        if "/" in key:
            return None, "key must not contain '/'"
        return key, None

    def _route_exists(self) -> bool:
        path = self._path()
        return path in ("/health", "/v1/keys") or path.startswith(KEY_PREFIX)

    def _read_json_body(self) -> tuple[Any | None, bool]:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._error(400, "Transfer-Encoding is not supported")
            return None, False

        lengths = self.headers.get_all("Content-Length", failobj=[])
        if len(lengths) != 1 or not lengths[0].isdigit():
            self.close_connection = True
            self._error(411, "a valid Content-Length header is required")
            return None, False
        length = int(lengths[0])
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return None, False
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("incomplete request body")
            decoded = raw.decode("utf-8")
            payload = json.loads(decoded, parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            self._error(400, f"malformed JSON: {exc}")
            return None, False
        return payload, True

    def do_GET(self) -> None:
        path = self._path()
        if path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            self._send_json(200, {"keys": self.store.keys()})
            return
        if path.startswith(KEY_PREFIX):
            key, error = self._key()
            if error:
                self._error(400, error)
                return
            assert key is not None
            found, value = self.store.get(key)
            if not found:
                self._error(404, "key not found")
                return
            self._send_json(200, {"key": key, "value": value})
            return
        self._error(404, "route not found")

    def do_PUT(self) -> None:
        if not self._path().startswith(KEY_PREFIX):
            if self._route_exists():
                self._method_not_allowed()
            else:
                self._error(404, "route not found")
            return
        key, error = self._key()
        if error:
            self._error(400, error)
            return
        payload, ok = self._read_json_body()
        if not ok:
            return
        if not isinstance(payload, dict):
            self._error(400, "request body must be a JSON object")
            return
        if "value" not in payload or not set(payload).issubset({"value", "ttl_seconds"}):
            self._error(400, "body must contain value and optional ttl_seconds only")
            return

        ttl = payload.get("ttl_seconds")
        if "ttl_seconds" in payload:
            if isinstance(ttl, bool) or not isinstance(ttl, (int, float)):
                self._error(400, "ttl_seconds must be a number")
                return
            try:
                valid_ttl = math.isfinite(ttl) and ttl > 0
                valid_expiry = math.isfinite(time.time() + ttl)
            except (OverflowError, TypeError):
                valid_ttl = valid_expiry = False
            if not valid_ttl or not valid_expiry:
                self._error(400, "ttl_seconds must be finite and greater than zero")
                return

        assert key is not None
        try:
            created = self.store.put(key, payload["value"], ttl)
        except StoreError as exc:
            print(f"error: {exc}", file=sys.stderr, flush=True)
            self._error(500, "failed to persist data")
            return
        self._send_json(201 if created else 200, {"key": key, "value": payload["value"]})

    def do_DELETE(self) -> None:
        if not self._path().startswith(KEY_PREFIX):
            if self._route_exists():
                self._method_not_allowed()
            else:
                self._error(404, "route not found")
            return
        key, error = self._key()
        if error:
            self._error(400, error)
            return
        assert key is not None
        try:
            deleted = self.store.delete(key)
        except StoreError as exc:
            print(f"error: {exc}", file=sys.stderr, flush=True)
            self._error(500, "failed to persist data")
            return
        if deleted:
            self._send_empty(204)
        else:
            self._error(404, "key not found")

    def _method_not_allowed(self) -> None:
        if self._route_exists():
            self._error(405, "method not allowed")
        else:
            self._error(404, "route not found")

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True, type=Path)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = Store(args.data)
        server = KVHTTPServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"error: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if stopping.is_set():
            return
        stopping.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    actual_port = server.server_address[1]
    print(f"LISTENING {actual_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
