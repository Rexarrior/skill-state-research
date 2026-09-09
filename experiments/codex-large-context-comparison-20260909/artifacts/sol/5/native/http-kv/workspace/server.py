#!/usr/bin/env python3
"""A small persistent HTTP key-value service using only the standard library."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import socket
import tempfile
import threading
import time
from decimal import Decimal, ROUND_CEILING
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
_HEX_ESCAPE = re.compile(r"%[0-9A-Fa-f]{2}")


class PersistenceError(Exception):
    """Raised when state cannot be durably written."""


class Store:
    """Thread-safe in-memory state backed by an atomically replaced JSON file."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._load()

    @staticmethod
    def _without_expired(
        entries: dict[str, dict[str, Any]], now_ns: int
    ) -> dict[str, dict[str, Any]]:
        return {
            key: entry
            for key, entry in entries.items()
            if entry["expires_at_ns"] is None
            or entry["expires_at_ns"] > now_ns
        }

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(
                    source,
                    parse_constant=lambda value: (_ for _ in ()).throw(
                        ValueError(f"invalid JSON number {value}")
                    ),
                )
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported persistence format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("persistence entries must be an object")

            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("persistence contains an invalid key")
                if not isinstance(entry, dict) or set(entry) != {
                    "value",
                    "expires_at_ns",
                }:
                    raise ValueError("persistence contains an invalid entry")
                expiry = entry["expires_at_ns"]
                if expiry is not None and (
                    not isinstance(expiry, int)
                    or isinstance(expiry, bool)
                    or expiry <= 0
                ):
                    raise ValueError("persistence contains an invalid expiration")
                loaded[key] = {"value": entry["value"], "expires_at_ns": expiry}

            self._entries = self._without_expired(loaded, time.time_ns())
            if len(self._entries) != len(loaded):
                self._write(self._entries)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise PersistenceError(f"cannot load data file {self.path}: {exc}") from exc

    def _write(self, entries: dict[str, dict[str, Any]]) -> None:
        payload = {"version": 1, "entries": entries}
        temp_name: str | None = None
        try:
            fd, temp_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
            )
            with os.fdopen(fd, "w", encoding="utf-8") as target:
                json.dump(
                    payload,
                    target,
                    ensure_ascii=True,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
                target.write("\n")
                target.flush()
                os.fsync(target.fileno())
            os.replace(temp_name, self.path)
            temp_name = None

            # Make the directory entry durable where the platform supports it.
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except (OSError, TypeError, ValueError) as exc:
            raise PersistenceError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass

    def _prune_locked(self) -> None:
        live = self._without_expired(self._entries, time.time_ns())
        if len(live) != len(self._entries):
            self._entries = live
            try:
                self._write(live)
            except PersistenceError as exc:
                print(str(exc), file=os.sys.stderr, flush=True)

    def put(self, key: str, value: Any, ttl: int | float | None) -> bool:
        with self._lock:
            self._prune_locked()
            created = key not in self._entries
            expires_at_ns = None
            if ttl is not None:
                ttl_ns = int(
                    (Decimal(str(ttl)) * Decimal(1_000_000_000)).to_integral_value(
                        rounding=ROUND_CEILING
                    )
                )
                expires_at_ns = time.time_ns() + max(1, ttl_ns)
            updated = dict(self._entries)
            updated[key] = {"value": value, "expires_at_ns": expires_at_ns}
            self._write(updated)
            self._entries = updated
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            self._prune_locked()
            if key not in self._entries:
                return False, None
            return True, self._entries[key]["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            self._prune_locked()
            if key not in self._entries:
                return False
            updated = dict(self._entries)
            del updated[key]
            self._write(updated)
            self._entries = updated
            return True

    def keys(self) -> list[str]:
        with self._lock:
            self._prune_locked()
            return sorted(self._entries)

    def close(self) -> None:
        with self._lock:
            self._prune_locked()


class KVServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = False
    block_on_close = True

    def __init__(self, address: tuple[str, int], store: Store):
        self.store = store
        self._connections: set[socket.socket] = set()
        self._connections_lock = threading.Lock()
        self._closing = False
        super().__init__(address, RequestHandler)

    def register_connection(self, connection: socket.socket) -> None:
        with self._connections_lock:
            if self._closing:
                connection.close()
            else:
                self._connections.add(connection)

    def unregister_connection(self, connection: socket.socket) -> None:
        with self._connections_lock:
            self._connections.discard(connection)

    def begin_close(self) -> None:
        """Stop idle keep-alive clients so request threads can be joined."""
        with self._connections_lock:
            self._closing = True
            connections = list(self._connections)
        self.socket.close()
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                connection.close()
            except OSError:
                pass


class IPv6KVServer(KVServer):
    address_family = socket.AF_INET6


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: KVServer

    def setup(self) -> None:
        super().setup()
        self.server.register_connection(self.connection)

    def finish(self) -> None:
        try:
            super().finish()
        finally:
            self.server.unregister_connection(self.connection)

    def __getattr__(self, name: str) -> Any:
        # BaseHTTPRequestHandler otherwise emits an HTML 501 response for an
        # unrecognized HTTP verb. Treat every verb consistently as a 4xx.
        if name.startswith("do_"):
            return self._unsupported_method
        raise AttributeError(name)

    def _send_json(self, status: int, payload: Any | None) -> None:
        body = b"" if payload is None else json.dumps(
            payload,
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        """Ensure parser-level errors from BaseHTTPRequestHandler are JSON."""
        del explain
        self._error(code, message or HTTPStatus(code).phrase)

    def _content_length(self) -> int | None:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            self._error(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
            self.close_connection = True
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return 0
        try:
            length = int(raw_length, 10)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            self.close_connection = True
            return None
        if length < 0:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            self.close_connection = True
            return None
        if length > MAX_BODY_BYTES:
            # Consuming a small overage prevents TCP reset from hiding the 413
            # response from clients that eagerly sent the whole request. Never
            # drain an unbounded declared length.
            if length <= MAX_BODY_BYTES + 64 * 1024:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            self.close_connection = True
            return None
        return length

    def handle_expect_100(self) -> bool:
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length, 10) if raw_length is not None else 0
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            self.close_connection = True
            return False
        if length < 0 or length > MAX_BODY_BYTES:
            status = (
                HTTPStatus.BAD_REQUEST
                if length < 0
                else HTTPStatus.REQUEST_ENTITY_TOO_LARGE
            )
            self._error(status, "invalid Content-Length" if length < 0 else "request body exceeds 1 MiB")
            self.close_connection = True
            return False
        return super().handle_expect_100()

    @staticmethod
    def _decode_key(encoded: str) -> tuple[str | None, str | None]:
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                match = _HEX_ESCAPE.match(encoded, index)
                if match is None:
                    return None, "key contains an invalid percent escape"
                index += 3
            else:
                index += 1
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return None, "key is not valid UTF-8"
        if not key:
            return None, "key must not be empty"
        if "/" in key:
            return None, "key must not contain '/'"
        return key, None

    def _route(self) -> tuple[str, str | None, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None, None
        path = parsed.path
        if path == "/health":
            return "health", None, None
        if path == "/v1/keys":
            return "keys", None, None
        if path.startswith("/v1/kv/"):
            key, error = self._decode_key(path[len("/v1/kv/") :])
            return "kv", key, error
        return "unknown", None, None

    def _discard_body(self) -> bool:
        length = self._content_length()
        if length is None:
            return False
        if length:
            self.rfile.read(length)
        return True

    def do_GET(self) -> None:
        if not self._discard_body():
            return
        route, key, key_error = self._route()
        if route == "health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
        elif route == "keys":
            self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
        elif route == "kv":
            if key_error:
                self._error(HTTPStatus.BAD_REQUEST, key_error)
                return
            found, value = self.server.store.get(key)  # type: ignore[arg-type]
            if found:
                self._send_json(HTTPStatus.OK, {"key": key, "value": value})
            else:
                self._error(HTTPStatus.NOT_FOUND, "key not found")
        else:
            self._error(HTTPStatus.NOT_FOUND, "route not found")

    def do_PUT(self) -> None:
        length = self._content_length()
        if length is None:
            return
        body = self.rfile.read(length)
        route, key, key_error = self._route()
        if route != "kv":
            if route == "unknown":
                self._error(HTTPStatus.NOT_FOUND, "route not found")
            else:
                self._method_not_allowed(route)
            return
        if key_error:
            self._error(HTTPStatus.BAD_REQUEST, key_error)
            return
        try:
            document = json.loads(
                body,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError(f"invalid JSON number {value}")
                ),
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON body")
            return
        if (
            not isinstance(document, dict)
            or "value" not in document
            or not set(document).issubset({"value", "ttl_seconds"})
        ):
            self._error(
                HTTPStatus.BAD_REQUEST,
                "body must be an object containing value and optional ttl_seconds",
            )
            return
        ttl = document.get("ttl_seconds")
        if "ttl_seconds" in document and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or ttl <= 0
            or (isinstance(ttl, float) and not math.isfinite(ttl))
        ):
            self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.server.store.put(key, document["value"], ttl)  # type: ignore[arg-type]
        except PersistenceError as exc:
            self.log_error("%s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not persist value")
            return
        self._send_json(HTTPStatus.CREATED if created else HTTPStatus.OK, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        if not self._discard_body():
            return
        route, key, key_error = self._route()
        if route != "kv":
            if route == "unknown":
                self._error(HTTPStatus.NOT_FOUND, "route not found")
            else:
                self._method_not_allowed(route)
            return
        if key_error:
            self._error(HTTPStatus.BAD_REQUEST, key_error)
            return
        try:
            deleted = self.server.store.delete(key)  # type: ignore[arg-type]
        except PersistenceError as exc:
            self.log_error("%s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not persist deletion")
            return
        if deleted:
            self._send_json(HTTPStatus.NO_CONTENT, None)
        else:
            self._error(HTTPStatus.NOT_FOUND, "key not found")

    def _method_not_allowed(self, route: str) -> None:
        allowed = "GET"
        if route == "kv":
            allowed = "GET, PUT, DELETE"
        self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
        self.send_header("Allow", allowed)
        body = json.dumps({"error": "method not allowed"}, separators=(",", ":")).encode()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _unsupported_method(self) -> None:
        if not self._discard_body():
            return
        route, _, _ = self._route()
        if route == "unknown":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
        else:
            self._method_not_allowed(route)

    do_POST = _unsupported_method
    do_PATCH = _unsupported_method
    do_OPTIONS = _unsupported_method
    do_HEAD = _unsupported_method
    do_TRACE = _unsupported_method
    do_CONNECT = _unsupported_method


class GracefulShutdown(Exception):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", required=True, help="interface to listen on")
    parser.add_argument("--port", required=True, type=int, help="TCP port (0 chooses a free port)")
    parser.add_argument("--data", required=True, type=Path, help="JSON persistence file")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = Store(args.data)
        server_class = IPv6KVServer if ":" in args.host else KVServer
        server = server_class((args.host, args.port), store)
    except (OSError, PersistenceError) as exc:
        print(f"startup error: {exc}", file=os.sys.stderr, flush=True)
        return 1

    previous_sigterm = signal.getsignal(signal.SIGTERM)

    def stop(_signum: int, _frame: Any) -> None:
        raise GracefulShutdown

    signal.signal(signal.SIGTERM, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    except (GracefulShutdown, KeyboardInterrupt):
        pass
    finally:
        server.begin_close()
        server.server_close()
        store.close()
        signal.signal(signal.SIGTERM, previous_sigterm)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
