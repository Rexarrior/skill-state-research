#!/usr/bin/env python3
"""A small, persistent HTTP key-value service."""

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


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class StoreError(Exception):
    """Raised when persistent state cannot be read or written."""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_expired(entry: dict[str, Any], now: float) -> bool:
        expiry = entry.get("expires_at")
        return expiry is not None and expiry <= now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                document = json.load(stream)
            raw_entries = document.get("entries") if isinstance(document, dict) else None
            if not isinstance(raw_entries, dict):
                raise ValueError("expected an object containing an 'entries' object")
            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("invalid entry")
                expiry = entry.get("expires_at")
                if expiry is not None and (
                    isinstance(expiry, bool)
                    or not isinstance(expiry, (int, float))
                    or not math.isfinite(expiry)
                ):
                    raise ValueError("invalid expiry")
                normalized = {"value": entry["value"], "expires_at": expiry}
                if not self._is_expired(normalized, now):
                    loaded[key] = normalized
            self.entries = loaded
            if len(loaded) != len(raw_entries):
                self._persist_locked()
        except (OSError, ValueError, json.JSONDecodeError, TypeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    def _persist_locked(self) -> None:
        parent = self.path.parent
        temporary: str | None = None
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=parent)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(
                    {"version": 1, "entries": self.entries},
                    stream,
                    ensure_ascii=True,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            temporary = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # The rename is still atomic on filesystems that cannot fsync directories.
                pass
        except (OSError, ValueError, TypeError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def _prune_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items() if self._is_expired(entry, now)]
        if not expired:
            return False
        previous = self.entries.copy()
        for key in expired:
            del self.entries[key]
        try:
            self._persist_locked()
        except StoreError:
            self.entries = previous
            raise
        return True

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._prune_locked()
            existed = key in self.entries
            previous = self.entries.get(key)
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl is None else time.time() + ttl,
            }
            try:
                self._persist_locked()
            except StoreError:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return existed

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._prune_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._prune_locked()
            previous = self.entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist_locked()
            except StoreError:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._prune_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: Server

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr, flush=True)

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        """Keep BaseHTTPRequestHandler-generated errors JSON-only."""
        del explain
        self._error(code, message or self.responses.get(code, ("error",))[0])

    def _send(self, status: int, payload: Any | None = None) -> None:
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send(status, {"error": message})

    def _route(self) -> tuple[str, str | None]:
        path = urlsplit(self.path).path
        if path == "/health":
            return "health", None
        if path == "/v1/keys":
            return "keys", None
        if path.startswith(KEY_PREFIX):
            encoded = path[len(KEY_PREFIX):]
            if not encoded or "/" in encoded or BAD_ESCAPE.search(encoded):
                raise ValueError("invalid key")
            try:
                key = unquote_to_bytes(encoded).decode("utf-8", "strict")
            except UnicodeDecodeError as exc:
                raise ValueError("key must be valid UTF-8") from exc
            if not key or "/" in key:
                raise ValueError("invalid key")
            return "key", key
        return "unknown", None

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(400, "transfer encoding is not supported")
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(length_header)
        except ValueError as exc:
            raise RequestError(400, "invalid Content-Length") from exc
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            # Consume a bounded amount before replying.  This lets ordinary
            # clients finish sending a just-over-limit body and receive the
            # JSON 413 response, without allowing an advertised huge body to
            # make us read an unbounded amount of data.
            self.rfile.read(min(length, MAX_BODY + 1))
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            return json.loads(
                body,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError(f"invalid JSON constant: {value}")
                ),
            )
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise RequestError(400, "malformed JSON") from exc
        except ValueError as exc:
            raise RequestError(400, "malformed JSON") from exc

    def _dispatch(self, method: str) -> None:
        try:
            route, key = self._route()
        except ValueError as exc:
            self._error(400, str(exc))
            return

        allowed = {
            "health": {"GET"},
            "keys": {"GET"},
            "key": {"GET", "PUT", "DELETE"},
        }
        if route == "unknown":
            self._error(404, "route not found")
            return
        if method not in allowed[route]:
            self.send_response(405)
            self.send_header("Allow", ", ".join(sorted(allowed[route])))
            body = json.dumps({"error": "method not allowed"}, separators=(",", ":")).encode()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        try:
            if route == "health":
                self._send(200, {"status": "ok"})
            elif route == "keys":
                self._send(200, {"keys": self.server.store.keys()})
            elif method == "GET":
                found, value = self.server.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._send(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            elif method == "DELETE":
                if self.server.store.delete(key):  # type: ignore[arg-type]
                    self._send(204)
                else:
                    self._error(404, "key not found")
            else:
                document = self._read_json()
                if not isinstance(document, dict) or "value" not in document:
                    raise RequestError(400, "body must be an object containing 'value'")
                extra = set(document) - {"value", "ttl_seconds"}
                if extra:
                    raise RequestError(400, "body contains unknown fields")
                ttl = document.get("ttl_seconds")
                if "ttl_seconds" in document and (
                    isinstance(ttl, bool)
                    or not isinstance(ttl, (int, float))
                    or not math.isfinite(ttl)
                    or ttl <= 0
                ):
                    raise RequestError(400, "ttl_seconds must be finite and greater than zero")
                replaced = self.server.store.put(key, document["value"], ttl)  # type: ignore[arg-type]
                self._send(200 if replaced else 201, {"key": key, "value": document["value"]})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except StoreError as exc:
            print(str(exc), file=sys.stderr, flush=True)
            self._error(500, "persistent storage error")
        except (ValueError, TypeError):
            self._error(400, "value is not valid JSON data")

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_OPTIONS(self) -> None:
        self._dispatch("OPTIONS")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def __getattr__(self, name: str) -> Any:
        """Route otherwise-valid, unknown HTTP methods through JSON errors."""
        if name.startswith("do_"):
            return lambda: self._dispatch(self.command)
        raise AttributeError(name)


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
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
    except (OSError, StoreError) as exc:
        print(f"startup error: {exc}", file=sys.stderr, flush=True)
        return 1

    def stop(_signum: int, _frame: Any) -> None:
        # shutdown() must run outside serve_forever's thread to avoid deadlock.
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
