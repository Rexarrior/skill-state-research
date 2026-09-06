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
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
_INVALID_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(Exception):
    """Raised when durable state cannot be read or written."""


@dataclass(frozen=True)
class Entry:
    value: Any
    expires_at: float | None


class Store:
    """Thread-safe store whose successful mutations are durable."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, Entry] = {}
        self._load()

    @staticmethod
    def _is_live(entry: Entry, now: float) -> bool:
        return entry.expires_at is None or entry.expires_at > now

    def _live_entries(self, now: float) -> dict[str, Entry]:
        return {
            key: entry
            for key, entry in self._entries.items()
            if self._is_live(entry, now)
        }

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                document = json.load(
                    stream,
                    parse_constant=lambda value: (_ for _ in ()).throw(
                        ValueError(f"invalid JSON constant {value}")
                    ),
                )
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("data-file entries must be an object")

            loaded: dict[str, Entry] = {}
            now = time.time()
            had_expired = False
            for key, raw in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("data file contains an invalid key")
                if not isinstance(raw, dict) or set(raw) != {"value", "expires_at"}:
                    raise ValueError("data file contains an invalid entry")
                expires_at = raw["expires_at"]
                if expires_at is not None:
                    if (
                        isinstance(expires_at, bool)
                        or not isinstance(expires_at, (int, float))
                        or not math.isfinite(expires_at)
                    ):
                        raise ValueError("data file contains an invalid expiry")
                    expires_at = float(expires_at)
                entry = Entry(raw["value"], expires_at)
                if self._is_live(entry, now):
                    loaded[key] = entry
                else:
                    had_expired = True
            self._entries = loaded
            if had_expired:
                self._persist(loaded)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    def _persist(self, entries: dict[str, Entry]) -> None:
        parent = self.path.parent
        temporary_name: str | None = None
        document = {
            "version": 1,
            "entries": {
                key: {"value": entry.value, "expires_at": entry.expires_at}
                for key, entry in entries.items()
            },
        }
        try:
            parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(
                    document,
                    stream,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # The file replacement is already atomic. Some platforms do not
                # permit fsync on a directory, so this durability enhancement is
                # best-effort.
                pass
        except (OSError, TypeError, ValueError, RecursionError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass

    def _remove_expired(self, now: float) -> bool:
        live = self._live_entries(now)
        if len(live) == len(self._entries):
            return False
        self._persist(live)
        self._entries = live
        return True

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self._lock:
            now = time.time()
            live = self._live_entries(now)
            created = key not in live
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            if expires_at is not None and not math.isfinite(expires_at):
                raise ValueError("ttl_seconds is too large")
            updated = dict(live)
            updated[key] = Entry(value, expires_at)
            self._persist(updated)
            self._entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            self._remove_expired(time.time())
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            return True, entry.value

    def delete(self, key: str) -> bool:
        with self._lock:
            now = time.time()
            live = self._live_entries(now)
            if key not in live:
                if len(live) != len(self._entries):
                    self._persist(live)
                    self._entries = live
                return False
            updated = dict(live)
            del updated[key]
            self._persist(updated)
            self._entries = updated
            return True

    def keys(self) -> list[str]:
        with self._lock:
            self._remove_expired(time.time())
            return sorted(self._entries)


class KVHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "persistent-kv/1"

    @property
    def kv_server(self) -> KVHTTPServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - {format_string % args}",
            file=sys.stderr,
            flush=True,
        )

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        """Keep errors generated by BaseHTTPRequestHandler JSON-formatted."""
        del explain
        if code == HTTPStatus.NOT_IMPLEMENTED:
            code = HTTPStatus.METHOD_NOT_ALLOWED
            error_code = "method_not_allowed"
            message = "method not allowed"
        else:
            try:
                phrase = HTTPStatus(code).phrase
            except ValueError:
                phrase = "request error"
            error_code = "request_error"
            message = message or phrase
        self.close_connection = True
        self._error(code, error_code, message)

    def _send_json(self, status: int, payload: Any | None = None) -> None:
        body = b""
        if payload is not None:
            body = json.dumps(
                payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
            ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, code: str, message: str) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}})

    def _route(self) -> tuple[str, str | None]:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            return "unknown", None
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if not parsed.path.startswith(prefix):
            return "unknown", None
        encoded_key = parsed.path[len(prefix) :]
        if not encoded_key or "/" in encoded_key:
            return "invalid_key", None
        if _INVALID_PERCENT_ESCAPE.search(encoded_key):
            return "invalid_key", None
        try:
            key = unquote_to_bytes(encoded_key).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return "invalid_key", None
        if not key or "/" in key:
            return "invalid_key", None
        return "key", key

    def _read_json_body(self) -> tuple[bool, Any]:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "invalid_body", "chunked bodies are not supported")
            return False, None
        lengths = self.headers.get_all("Content-Length", failobj=[])
        if len(lengths) != 1:
            self.close_connection = True
            self._error(HTTPStatus.LENGTH_REQUIRED, "length_required", "exactly one Content-Length header is required")
            return False, None
        try:
            length = int(lengths[0], 10)
        except (TypeError, ValueError):
            length = -1
        if length < 0:
            self.close_connection = True
            self._error(HTTPStatus.BAD_REQUEST, "invalid_length", "invalid Content-Length")
            return False, None
        if length > MAX_BODY_BYTES:
            # Consume at most one byte beyond the supported size. This lets a
            # normal client finish sending a just-over-limit request and receive
            # the 413, without trusting or buffering an arbitrarily large length.
            remaining = min(length, MAX_BODY_BYTES + 1)
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "body_too_large", "request body exceeds 1 MiB")
            return False, None
        try:
            raw = self.rfile.read(length)
            text = raw.decode("utf-8", errors="strict")
            return True, json.loads(
                text,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError(f"invalid JSON constant {value}")
                ),
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError, RecursionError):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json", "request body must be valid JSON")
            return False, None

    @staticmethod
    def _validate_put(document: Any) -> tuple[bool, Any, float | None, str]:
        if not isinstance(document, dict):
            return False, None, None, "request body must be a JSON object"
        if "value" not in document:
            return False, None, None, "request body must contain value"
        if not set(document).issubset({"value", "ttl_seconds"}):
            return False, None, None, "request body contains unknown fields"
        ttl = document.get("ttl_seconds")
        if ttl is not None:
            if isinstance(ttl, bool) or not isinstance(ttl, (int, float)):
                return False, None, None, "ttl_seconds must be a number"
            if not math.isfinite(ttl) or ttl <= 0:
                return False, None, None, "ttl_seconds must be finite and greater than zero"
            ttl = float(ttl)
        return True, document["value"], ttl, ""

    def do_GET(self) -> None:
        route, key = self._route()
        try:
            if route == "health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
            elif route == "keys":
                self._send_json(HTTPStatus.OK, {"keys": self.kv_server.store.keys()})
            elif route == "key":
                found, value = self.kv_server.store.get(key or "")
                if found:
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "not_found", "key not found")
            elif route == "invalid_key":
                self._error(HTTPStatus.BAD_REQUEST, "invalid_key", "key must be non-empty UTF-8 without slash")
            else:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "route not found")
        except (StoreError, RecursionError) as exc:
            print(str(exc), file=sys.stderr, flush=True)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "persistent storage failure")

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid_key", "key must be non-empty UTF-8 without slash")
            return
        if route != "key":
            if route in {"health", "keys"}:
                self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "method not allowed")
            else:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "route not found")
            return
        body_ok, document = self._read_json_body()
        if not body_ok:
            return
        valid, value, ttl, message = self._validate_put(document)
        if not valid:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_body", message)
            return
        try:
            created = self.kv_server.store.put(key or "", value, ttl)
        except ValueError as exc:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_ttl", str(exc))
        except StoreError as exc:
            print(str(exc), file=sys.stderr, flush=True)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "persistent storage failure")
        else:
            self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": value})

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "invalid_key":
            self._error(HTTPStatus.BAD_REQUEST, "invalid_key", "key must be non-empty UTF-8 without slash")
            return
        if route != "key":
            if route in {"health", "keys"}:
                self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "method not allowed")
            else:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "route not found")
            return
        try:
            deleted = self.kv_server.store.delete(key or "")
        except StoreError as exc:
            print(str(exc), file=sys.stderr, flush=True)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "persistent storage failure")
            return
        if deleted:
            self._send_json(HTTPStatus.NO_CONTENT)
        else:
            self._error(HTTPStatus.NOT_FOUND, "not_found", "key not found")

    def _unsupported(self) -> None:
        route, _ = self._route()
        if route == "unknown":
            self._error(HTTPStatus.NOT_FOUND, "not_found", "route not found")
        else:
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported
    do_TRACE = _unsupported
    do_CONNECT = _unsupported


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
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
        store = Store(args.data)
        server = KVHTTPServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr, flush=True)
        return 1

    def stop(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
