#!/usr/bin/env python3
"""A small persistent HTTP key-value service."""

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
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024


class StoreError(Exception):
    """Raised when durable storage cannot be read or written."""


@dataclass
class Entry:
    value: Any
    expires_at: float | None


class Store:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, Entry] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle)
            raw_entries = document["entries"]
            if not isinstance(raw_entries, dict):
                raise ValueError("entries must be an object")
            now = time.time()
            discarded_expired = False
            loaded: dict[str, Entry] = {}
            for key, raw in raw_entries.items():
                if not isinstance(key, str) or not isinstance(raw, dict):
                    raise ValueError("invalid entry")
                if set(raw) != {"value", "expires_at"}:
                    raise ValueError("invalid entry shape")
                expires_at = raw["expires_at"]
                if expires_at is not None:
                    if (
                        isinstance(expires_at, bool)
                        or not isinstance(expires_at, (int, float))
                        or not math.isfinite(expires_at)
                    ):
                        raise ValueError("invalid expiration")
                    expires_at = float(expires_at)
                    if expires_at <= now:
                        discarded_expired = True
                        continue
                loaded[key] = Entry(raw["value"], expires_at)
            self._entries = loaded
            if discarded_expired:
                self._persist_locked()
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

    def _prune_locked(self) -> bool:
        now = time.time()
        expired = [
            key
            for key, entry in self._entries.items()
            if entry.expires_at is not None and entry.expires_at <= now
        ]
        for key in expired:
            del self._entries[key]
        return bool(expired)

    def _document_locked(self) -> dict[str, Any]:
        return {
            "entries": {
                key: {"value": entry.value, "expires_at": entry.expires_at}
                for key, entry in self._entries.items()
            }
        }

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    self._document_locked(),
                    handle,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Directory fsync is unavailable on some platforms. The atomic
                # replacement itself has already completed successfully.
                pass
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            if self._prune_locked():
                self._persist_locked()
            entry = self._entries.get(key)
            return (False, None) if entry is None else (True, entry.value)

    def keys(self) -> list[str]:
        with self._lock:
            if self._prune_locked():
                self._persist_locked()
            return sorted(self._entries)

    def put(self, key: str, value: Any, ttl_seconds: float | None) -> bool:
        with self._lock:
            self._prune_locked()
            created = key not in self._entries
            previous = self._entries.get(key)
            expires_at = None if ttl_seconds is None else time.time() + ttl_seconds
            self._entries[key] = Entry(value, expires_at)
            try:
                self._persist_locked()
            except StoreError:
                if previous is None:
                    del self._entries[key]
                else:
                    self._entries[key] = previous
                raise
            return created

    def delete(self, key: str) -> bool:
        with self._lock:
            pruned = self._prune_locked()
            previous = self._entries.pop(key, None)
            if previous is None:
                if pruned:
                    self._persist_locked()
                return False
            try:
                self._persist_locked()
            except StoreError:
                self._entries[key] = previous
                raise
            return True

    def flush(self) -> None:
        with self._lock:
            self._prune_locked()
            self._persist_locked()


class KVHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        super().__init__(address, RequestHandler)
        self.store = store


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

    def _send_json(self, status: int, payload: Any | None = None) -> None:
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _read_json(self) -> Any:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            raise HTTPInputError(400, "transfer encoding is not supported")
        length_text = self.headers.get("Content-Length")
        if length_text is None:
            raise HTTPInputError(411, "Content-Length is required")
        try:
            length = int(length_text)
        except ValueError as exc:
            raise HTTPInputError(400, "invalid Content-Length") from exc
        if length < 0:
            raise HTTPInputError(400, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            # Drain only a small overflow beyond the accepted limit.  This lets
            # ordinary clients finish an upload that was already in flight and
            # receive the 413 response, without allowing an attacker-declared
            # enormous Content-Length to tie up a worker indefinitely.
            drain_length = min(length, MAX_BODY_BYTES + 1)
            remaining = drain_length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            raise HTTPInputError(413, "request body exceeds 1 MiB")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise HTTPInputError(400, "incomplete request body")
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPInputError(400, "malformed JSON") from exc

    @staticmethod
    def _decode_key(path: str) -> str | None:
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix) :]
        hex_digits = frozenset("0123456789abcdefABCDEF")
        position = 0
        while position < len(encoded):
            if encoded[position] == "%":
                if (
                    position + 2 >= len(encoded)
                    or encoded[position + 1] not in hex_digits
                    or encoded[position + 2] not in hex_digits
                ):
                    raise HTTPInputError(400, "invalid URL encoding in key")
                position += 3
            else:
                position += 1
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPInputError(400, "key must be valid UTF-8") from exc
        if not key or "/" in key:
            raise HTTPInputError(400, "key must be non-empty and cannot contain '/'")
        return key

    def _path(self) -> str:
        return urlsplit(self.path).path

    def do_GET(self) -> None:
        try:
            path = self._path()
            if path == "/health":
                self._send_json(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._send_json(200, {"keys": self.kv_server.store.keys()})
                return
            key = self._decode_key(path)
            if key is not None:
                found, value = self.kv_server.store.get(key)
                if found:
                    self._send_json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
                return
            self._error(404, "route not found")
        except HTTPInputError as exc:
            self._error(exc.status, exc.message)
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        try:
            key = self._decode_key(self._path())
            if key is None:
                self._error(404, "route not found")
                return
            document = self._read_json()
            if not isinstance(document, dict):
                raise HTTPInputError(400, "request body must be a JSON object")
            if "value" not in document or not set(document).issubset(
                {"value", "ttl_seconds"}
            ):
                raise HTTPInputError(
                    400, "body must contain value and optional ttl_seconds"
                )
            ttl = document.get("ttl_seconds")
            if ttl is not None:
                if (
                    isinstance(ttl, bool)
                    or not isinstance(ttl, (int, float))
                    or not math.isfinite(ttl)
                    or ttl <= 0
                ):
                    raise HTTPInputError(400, "ttl_seconds must be finite and > 0")
                ttl = float(ttl)
            created = self.kv_server.store.put(key, document["value"], ttl)
            self._send_json(201 if created else 200, {"key": key, "value": document["value"]})
        except HTTPInputError as exc:
            self._error(exc.status, exc.message)
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_DELETE(self) -> None:
        try:
            key = self._decode_key(self._path())
            if key is None:
                self._error(404, "route not found")
                return
            if self.kv_server.store.delete(key):
                self._send_json(204)
            else:
                self._error(404, "key not found")
        except HTTPInputError as exc:
            self._error(exc.status, exc.message)
        except StoreError as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def _unsupported(self) -> None:
        path = self._path()
        try:
            known = path in {"/health", "/v1/keys"} or self._decode_key(path) is not None
        except HTTPInputError as exc:
            self._error(exc.status, exc.message)
            return
        if known:
            self._error(405, "method not allowed")
        else:
            self._error(404, "route not found")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported
    do_HEAD = _unsupported


class HTTPInputError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


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
        server = KVHTTPServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"startup error: {exc}", file=sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop(signum: int, _frame: Any) -> None:
        if stopping.is_set():
            return
        stopping.set()
        print(f"received signal {signum}, shutting down", file=sys.stderr, flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    exit_code = 0
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        try:
            store.flush()
        except StoreError as exc:
            print(f"shutdown storage error: {exc}", file=sys.stderr, flush=True)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
