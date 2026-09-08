#!/usr/bin/env python3
"""A small persistent HTTP key-value service."""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_SIZE = 1024 * 1024
HEX_DIGITS = frozenset("0123456789abcdefABCDEF")


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


class Store:
    """Thread-safe key-value state backed by an atomically replaced JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as handle:
            raw = json.load(handle, parse_constant=_reject_json_constant)
        if not isinstance(raw, dict) or raw.get("version") != 1:
            raise ValueError("data file has an unsupported format")
        entries = raw.get("entries")
        if not isinstance(entries, dict):
            raise ValueError("data file entries must be an object")

        now = time.time()
        loaded: dict[str, dict[str, Any]] = {}
        removed_expired = False
        for key, entry in entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise ValueError("data file contains an invalid key")
            if not isinstance(entry, dict) or "value" not in entry:
                raise ValueError("data file contains an invalid entry")
            expires_at = entry.get("expires_at")
            if expires_at is not None and (
                isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or not math.isfinite(expires_at)
            ):
                raise ValueError("data file contains an invalid expiration")
            normalized = {"value": entry["value"], "expires_at": expires_at}
            if self._is_live(normalized, now):
                loaded[key] = normalized
            else:
                removed_expired = True
        self.entries = loaded
        if removed_expired:
            self._persist()

    def _persist(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        document = {"version": 1, "entries": self.entries}
        temp_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temp_name = handle.name
                json.dump(
                    document,
                    handle,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.path)
            temp_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some platforms/filesystems do not support syncing directories.
                pass
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except FileNotFoundError:
                    pass

    def _remove_expired(self, now: float) -> bool:
        expired = [
            key for key, entry in self.entries.items() if not self._is_live(entry, now)
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        """Store a value and return True when a new live key was created."""
        with self.lock:
            now = time.time()
            old_entries = self.entries.copy()
            self._remove_expired(now)
            created = key not in self.entries
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl is None else now + ttl,
            }
            try:
                self._persist()
            except Exception:
                self.entries = old_entries
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if not self._is_live(entry, time.time()):
                del self.entries[key]
                try:
                    self._persist()
                except Exception as exc:
                    print(f"warning: could not persist expiration: {exc}", file=os.sys.stderr)
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None or not self._is_live(entry, time.time()):
                if entry is not None:
                    del self.entries[key]
                    try:
                        self._persist()
                    except Exception as exc:
                        print(
                            f"warning: could not persist expiration: {exc}",
                            file=os.sys.stderr,
                        )
                return False
            old_entry = entry
            del self.entries[key]
            try:
                self._persist()
            except Exception:
                self.entries[key] = old_entry
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            changed = self._remove_expired(time.time())
            if changed:
                try:
                    self._persist()
                except Exception as exc:
                    print(f"warning: could not persist expiration: {exc}", file=os.sys.stderr)
            return sorted(self.entries)


class KVServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = False

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] {format % args}",
            file=os.sys.stderr,
        )

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        # BaseHTTPRequestHandler otherwise emits an HTML error (including for an
        # unrecognized HTTP method). Keep every API error JSON.
        if code == HTTPStatus.NOT_IMPLEMENTED:
            code = HTTPStatus.METHOD_NOT_ALLOWED
            message = "method not allowed"
        self._json_error(code, message or HTTPStatus(code).phrase.lower())

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

    def _json_error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _body_length(self) -> int | None:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            self._json_error(HTTPStatus.BAD_REQUEST, "transfer encoding is not supported")
            return None
        raw = self.headers.get("Content-Length")
        if raw is None:
            self._json_error(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            return None
        try:
            length = int(raw)
        except ValueError:
            self._json_error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length < 0:
            self._json_error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length > MAX_BODY_SIZE:
            # Consume the payload without retaining it.  Responding while bytes are
            # still queued commonly makes the TCP close surface as a reset instead
            # of the useful 413 response, and would also desynchronise a persistent
            # connection.
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    self.close_connection = True
                    break
                remaining -= len(chunk)
            self._json_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body is too large")
            return None
        return length

    def _read_json(self) -> tuple[bool, Any]:
        length = self._body_length()
        if length is None:
            return False, None
        raw = self.rfile.read(length)
        try:
            text = raw.decode("utf-8")
            return True, json.loads(text, parse_constant=_reject_json_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._json_error(HTTPStatus.BAD_REQUEST, "malformed JSON")
            return False, None

    @staticmethod
    def _decode_key(path: str) -> tuple[str | None, str | None]:
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None, None
        encoded = path[len(prefix) :]
        for index, character in enumerate(encoded):
            if character == "%" and (
                index + 2 >= len(encoded)
                or encoded[index + 1] not in HEX_DIGITS
                or encoded[index + 2] not in HEX_DIGITS
            ):
                return None, "invalid URL encoding"
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            return None, "key must be valid UTF-8"
        if not key or "/" in key:
            return None, "key must be non-empty and must not contain '/'"
        return key, None

    def _route(self) -> tuple[str, str | None, str | None]:
        try:
            path = urlsplit(self.path).path
        except ValueError:
            return "invalid", None, "invalid request path"
        if path == "/health":
            return "health", None, None
        if path == "/v1/keys":
            return "keys", None, None
        key, error = self._decode_key(path)
        if error is not None:
            return "invalid", None, error
        if key is not None:
            return "key", key, None
        return "unknown", None, None

    def do_GET(self) -> None:
        route, key, error = self._route()
        if error is not None:
            self._json_error(HTTPStatus.BAD_REQUEST, error)
        elif route == "health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
        elif route == "keys":
            self._send_json(HTTPStatus.OK, {"keys": self.server.store.keys()})
        elif route == "key":
            found, value = self.server.store.get(key)  # type: ignore[arg-type]
            if found:
                self._send_json(HTTPStatus.OK, {"key": key, "value": value})
            else:
                self._json_error(HTTPStatus.NOT_FOUND, "key not found")
        else:
            self._json_error(HTTPStatus.NOT_FOUND, "route not found")

    def do_PUT(self) -> None:
        route, key, error = self._route()
        if error is not None:
            self._json_error(HTTPStatus.BAD_REQUEST, error)
            return
        if route != "key":
            if route == "unknown":
                self._json_error(HTTPStatus.NOT_FOUND, "route not found")
            else:
                self._json_error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
            return
        ok, body = self._read_json()
        if not ok:
            return
        if (
            not isinstance(body, dict)
            or "value" not in body
            or not set(body).issubset({"value", "ttl_seconds"})
        ):
            self._json_error(
                HTTPStatus.BAD_REQUEST,
                "body must be an object containing value and optional ttl_seconds",
            )
            return
        ttl = body.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._json_error(
                HTTPStatus.BAD_REQUEST, "ttl_seconds must be a finite number greater than zero"
            )
            return
        try:
            created = self.server.store.put(key, body["value"], ttl)  # type: ignore[arg-type]
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("could not persist value: %s", exc)
            self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not persist value")
            return
        self._send_json(
            HTTPStatus.CREATED if created else HTTPStatus.OK,
            {"key": key, "value": body["value"]},
        )

    def do_DELETE(self) -> None:
        route, key, error = self._route()
        if error is not None:
            self._json_error(HTTPStatus.BAD_REQUEST, error)
            return
        if route != "key":
            if route == "unknown":
                self._json_error(HTTPStatus.NOT_FOUND, "route not found")
            else:
                self._json_error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
            return
        try:
            deleted = self.server.store.delete(key)  # type: ignore[arg-type]
        except OSError as exc:
            self.log_error("could not persist deletion: %s", exc)
            self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not persist deletion")
            return
        if not deleted:
            self._json_error(HTTPStatus.NOT_FOUND, "key not found")
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unsupported(self) -> None:
        route, _, error = self._route()
        if error is not None:
            self._json_error(HTTPStatus.BAD_REQUEST, error)
        elif route == "unknown":
            self._json_error(HTTPStatus.NOT_FOUND, "route not found")
        else:
            self._json_error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported
    do_HEAD = _unsupported


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
        server = KVServer((args.host, args.port), store)
    except Exception as exc:
        print(f"startup failed: {exc}", file=os.sys.stderr)
        return 1

    stopping = threading.Event()

    def request_stop(signum: int, frame: Any) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    server.timeout = 0.5
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        while not stopping.is_set():
            server.handle_request()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
