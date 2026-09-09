#!/usr/bin/env python3
"""A small, persistent HTTP key-value service."""

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
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
FORMAT_VERSION = 1


class StoreError(Exception):
    """Raised when durable storage cannot be read or written."""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_expired(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is not None and expires_at <= now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            if not isinstance(document, dict):
                raise ValueError("top-level value is not an object")
            if document.get("version") != FORMAT_VERSION:
                raise ValueError("unsupported or missing format version")
            entries = document.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("entries is not an object")

            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("stored entry has an invalid key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("stored entry has an invalid shape")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("stored entry has an invalid expiry")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        except (OSError, ValueError, TypeError, json.JSONDecodeError, RecursionError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

        self._entries = loaded
        if self._purge_expired_locked(time.time()):
            self._persist_locked()

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"non-finite number {value}")

    def _purge_expired_locked(self, now: float) -> bool:
        expired = [
            key for key, entry in self._entries.items() if self._is_expired(entry, now)
        ]
        for key in expired:
            del self._entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                dir=parent, prefix=f".{self.path.name}.", suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as output:
                    json.dump(
                        {"version": FORMAT_VERSION, "entries": self._entries},
                        output,
                        ensure_ascii=True,
                        allow_nan=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                    output.write("\n")
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary_name, self.path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    # Some filesystems do not support syncing directories.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except (OSError, ValueError, TypeError, RecursionError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self._lock:
            before = self._entries.copy()
            now = time.time()
            self._purge_expired_locked(now)
            created = key not in self._entries
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            if expires_at is not None and not math.isfinite(expires_at):
                raise ValueError("ttl_seconds is too large")
            self._entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except StoreError:
                self._entries = before
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            if self._is_expired(entry, time.time()):
                del self._entries[key]
                self._persist_expiry_best_effort()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self._lock:
            before = self._entries.copy()
            entry = self._entries.get(key)
            if entry is None:
                return False
            if self._is_expired(entry, time.time()):
                del self._entries[key]
                self._persist_expiry_best_effort()
                return False
            del self._entries[key]
            try:
                self._persist_locked()
            except StoreError:
                self._entries = before
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            if self._purge_expired_locked(time.time()):
                self._persist_expiry_best_effort()
            return sorted(self._entries)

    def _persist_expiry_best_effort(self) -> None:
        try:
            self._persist_locked()
        except StoreError as exc:
            print(f"warning: {exc}", file=sys.stderr, flush=True)


class KVServer(ThreadingHTTPServer):
    # Do not let an idle keep-alive client prevent SIGTERM shutdown. Mutations
    # remain atomic even if a request thread is still winding down.
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

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
        """Keep errors generated by BaseHTTPRequestHandler JSON as well."""
        if code == HTTPStatus.NOT_IMPLEMENTED:
            self._unsupported()
            return
        self._error(code, message or HTTPStatus(code).phrase)

    def _send_json(
        self,
        status: int,
        payload: Any,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        encoded = json.dumps(
            payload, ensure_ascii=True, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        self.end_headers()
        if getattr(self, "command", None) != "HEAD":
            self.wfile.write(encoded)

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, message: str, **headers: str) -> None:
        self._send_json(status, {"error": message}, headers or None)

    def _route(self) -> tuple[str, str | None]:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            return "invalid", None
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if parsed.path.startswith(prefix):
            encoded_key = parsed.path[len(prefix) :]
            return "kv", self._decode_key(encoded_key)
        return "unknown", None

    @staticmethod
    def _decode_key(encoded: str) -> str | None:
        hex_digits = frozenset("0123456789abcdefABCDEF")
        for index, character in enumerate(encoded):
            if character == "%" and (
                index + 2 >= len(encoded)
                or encoded[index + 1] not in hex_digits
                or encoded[index + 2] not in hex_digits
            ):
                return None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        if not key or "/" in key:
            return None
        return key

    def _dispatch_route(self, allowed: set[str]) -> tuple[str, str | None] | None:
        route, key = self._route()
        if route == "invalid" or (route == "kv" and key is None):
            self._error(HTTPStatus.BAD_REQUEST, "invalid key or request target")
            self.close_connection = True
            return None
        if route == "unknown":
            self._error(HTTPStatus.NOT_FOUND, "route not found")
            self.close_connection = True
            return None
        if route not in allowed:
            methods = {
                "health": "GET",
                "keys": "GET",
                "kv": "GET, PUT, DELETE",
            }[route]
            self._error(
                HTTPStatus.METHOD_NOT_ALLOWED,
                "method not allowed",
                Allow=methods,
            )
            return None
        return route, key

    def _content_length(self) -> int | None:
        values = self.headers.get_all("Content-Length", [])
        if len(values) != 1:
            self._error(HTTPStatus.BAD_REQUEST, "a single Content-Length is required")
            self.close_connection = True
            return None
        try:
            length = int(values[0], 10)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            self.close_connection = True
            return None
        if length < 0:
            self._error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            self.close_connection = True
            return None
        if length > MAX_BODY_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            self.close_connection = True
            return None
        return length

    def _read_json_body(self) -> Any:
        length = self._content_length()
        if length is None:
            raise RequestHandled
        try:
            raw = self.rfile.read(length)
            text = raw.decode("utf-8", errors="strict")
            return json.loads(text, parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError, RecursionError):
            self._error(HTTPStatus.BAD_REQUEST, "malformed JSON body")
            raise RequestHandled

    def handle_expect_100(self) -> bool:
        raw_length = self.headers.get("Content-Length")
        try:
            too_large = raw_length is not None and int(raw_length, 10) > MAX_BODY_BYTES
        except ValueError:
            too_large = False
        if too_large:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body exceeds 1 MiB")
            self.close_connection = True
            return False
        return super().handle_expect_100()

    def do_GET(self) -> None:
        selected = self._dispatch_route({"health", "keys", "kv"})
        if selected is None:
            return
        route, key = selected
        try:
            if route == "health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
            elif route == "keys":
                self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
            else:
                assert key is not None
                found, value = self.server.store.get(key)
                if found:
                    self._send_json(HTTPStatus.OK, {"key": key, "value": value})
                else:
                    self._error(HTTPStatus.NOT_FOUND, "key not found")
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")

    def do_PUT(self) -> None:
        selected = self._dispatch_route({"kv"})
        if selected is None:
            return
        _, key = selected
        assert key is not None
        try:
            body = self._read_json_body()
        except RequestHandled:
            return
        if not isinstance(body, dict) or "value" not in body or not set(body) <= {
            "value",
            "ttl_seconds",
        }:
            self._error(
                HTTPStatus.BAD_REQUEST,
                "body must be an object containing value and optional ttl_seconds",
            )
            return
        ttl = body.get("ttl_seconds")
        if "ttl_seconds" in body:
            if (
                ttl is None
                or isinstance(ttl, bool)
                or not isinstance(ttl, (int, float))
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "ttl_seconds must be a finite number greater than zero",
                )
                return
            try:
                ttl = float(ttl)
            except OverflowError:
                ttl = math.inf
            if not math.isfinite(ttl) or ttl <= 0:
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "ttl_seconds must be a finite number greater than zero",
                )
                return
        try:
            created = self.server.store.put(key, body["value"], ttl)
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "ttl_seconds is too large")
            return
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")
            return
        self._send_json(
            HTTPStatus.CREATED if created else HTTPStatus.OK,
            {"key": key, "value": body["value"]},
        )

    def do_DELETE(self) -> None:
        selected = self._dispatch_route({"kv"})
        if selected is None:
            return
        _, key = selected
        assert key is not None
        try:
            deleted = self.server.store.delete(key)
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage error")
            return
        if deleted:
            self._send_empty(HTTPStatus.NO_CONTENT)
        else:
            self._error(HTTPStatus.NOT_FOUND, "key not found")

    def _unsupported(self) -> None:
        selected = self._dispatch_route(set())
        if selected is not None:  # pragma: no cover - an empty allowed set never passes
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported
    do_HEAD = _unsupported
    do_TRACE = _unsupported
    do_CONNECT = _unsupported


class RequestHandled(Exception):
    pass


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True, type=Path)
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        store = Store(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"error: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def request_stop(_signum: int, _frame: Any) -> None:
        stopping.set()

    old_term = signal.signal(signal.SIGTERM, request_stop)
    old_int = signal.signal(signal.SIGINT, request_stop)
    serving = threading.Thread(target=server.serve_forever, name="http-server")
    serving.start()
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        stopping.wait()
    finally:
        server.shutdown()
        serving.join()
        server.server_close()
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGINT, old_int)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
