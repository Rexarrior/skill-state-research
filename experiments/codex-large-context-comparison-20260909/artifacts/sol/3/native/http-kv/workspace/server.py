#!/usr/bin/env python3
"""A small, persistent HTTP key-value service."""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote


MAX_BODY_BYTES = 1024 * 1024
API_PREFIX = "/v1/kv/"


class StoreError(Exception):
    """Raised when durable storage cannot be updated."""


class PersistentStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                document = json.load(stream, parse_constant=self._reject_constant)
            raw_entries = document["entries"]
            if not isinstance(document, dict) or not isinstance(raw_entries, dict):
                raise ValueError("top-level object or entries mapping is invalid")

            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("invalid persisted key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid persisted entry")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid persisted expiration")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise StoreError(f"cannot load data file {self.path}: {exc}") from exc

        now = time.time()
        self._entries = {
            key: entry for key, entry in loaded.items() if self._is_live(entry, now)
        }
        if len(self._entries) != len(loaded):
            self._persist(self._entries)

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"non-standard JSON constant: {value}")

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(
                        {"entries": entries},
                        stream,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary_name, self.path)
                try:
                    directory_fd = os.open(parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    # Some platforms/filesystems do not permit directory fsync.
                    pass
            except BaseException:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass
                raise
        except (OSError, TypeError, ValueError) as exc:
            raise StoreError(f"cannot persist data file {self.path}: {exc}") from exc

    def _without_expired(self, now: float) -> tuple[dict[str, dict[str, Any]], bool]:
        live = {
            key: entry
            for key, entry in self._entries.items()
            if self._is_live(entry, now)
        }
        return live, len(live) != len(self._entries)

    def _commit_expiration_cleanup(
        self, live: dict[str, dict[str, Any]], changed: bool
    ) -> None:
        if changed:
            try:
                self._persist(live)
            except StoreError as exc:
                # Expiration remains authoritative in memory even if cleanup cannot
                # immediately be written; absolute timestamps keep restart safe.
                print(str(exc), file=os.sys.stderr, flush=True)
            self._entries = live

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            live, changed = self._without_expired(time.time())
            self._commit_expiration_cleanup(live, changed)
            entry = self._entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def keys(self) -> list[str]:
        with self._lock:
            live, changed = self._without_expired(time.time())
            self._commit_expiration_cleanup(live, changed)
            return sorted(self._entries)

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self._lock:
            now = time.time()
            live, _ = self._without_expired(now)
            created = key not in live
            expires_at = None if ttl_seconds is None else now + ttl_seconds
            if expires_at is not None and not math.isfinite(expires_at):
                raise ValueError("ttl_seconds is too large")
            updated = dict(live)
            updated[key] = {"value": value, "expires_at": expires_at}
            self._persist(updated)
            self._entries = updated
            return created

    def delete(self, key: str) -> bool:
        with self._lock:
            live, expired = self._without_expired(time.time())
            if key not in live:
                self._commit_expiration_cleanup(live, expired)
                return False
            updated = dict(live)
            del updated[key]
            self._persist(updated)
            self._entries = updated
            return True


class KVRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"

    @property
    def store(self) -> PersistentStore:
        return self.server.store  # type: ignore[attr-defined]

    def _send_json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(
            payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def __getattr__(self, name: str) -> Any:
        # BaseHTTPRequestHandler otherwise turns unimplemented verbs into 501.
        # Every syntactically valid but unsupported HTTP method is a client error
        # for this API and receives the same JSON 405 response.
        if name.startswith("do_"):
            return self._unsupported
        raise AttributeError(name)

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _route_path(self) -> str | None:
        if "?" in self.path or "#" in self.path:
            return None
        return self.path

    def _key(self) -> tuple[str | None, str | None]:
        path = self._route_path()
        if path is None or not path.startswith(API_PREFIX):
            return None, "route"
        encoded = path[len(API_PREFIX) :]
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                if index + 2 >= len(encoded) or any(
                    char not in "0123456789abcdefABCDEF"
                    for char in encoded[index + 1 : index + 3]
                ):
                    return None, "invalid"
                index += 3
            else:
                index += 1
        try:
            key = unquote(encoded, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return None, "invalid"
        if not key or "/" in key:
            return None, "invalid"
        return key, None

    def _read_json(self) -> tuple[bool, Any]:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            self.close_connection = True
            self._error(400, "transfer encoding is not supported")
            return False, None

        lengths = self.headers.get_all("Content-Length", failobj=[])
        if len(lengths) != 1:
            self.close_connection = True
            self._error(400, "a single Content-Length header is required")
            return False, None
        try:
            length = int(lengths[0], 10)
        except ValueError:
            self.close_connection = True
            self._error(400, "invalid Content-Length")
            return False, None
        if length < 0:
            self.close_connection = True
            self._error(400, "invalid Content-Length")
            return False, None
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return False, None
        try:
            raw = self.rfile.read(length)
            document = json.loads(
                raw.decode("utf-8"), parse_constant=PersistentStore._reject_constant
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError, RecursionError):
            self._error(400, "malformed JSON")
            return False, None
        return True, document

    def do_GET(self) -> None:
        path = self._route_path()
        if path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            self._send_json(200, {"keys": self.store.keys()})
            return
        key, error = self._key()
        if error == "invalid":
            self._error(400, "invalid key")
            return
        if error == "route":
            self._error(404, "route not found")
            return
        found, value = self.store.get(key)  # type: ignore[arg-type]
        if not found:
            self._error(404, "key not found")
            return
        self._send_json(200, {"key": key, "value": value})

    def do_PUT(self) -> None:
        key, error = self._key()
        if error == "invalid":
            self._error(400, "invalid key")
            return
        if error == "route":
            self._error(404, "route not found")
            return
        valid, document = self._read_json()
        if not valid:
            return
        if (
            not isinstance(document, dict)
            or "value" not in document
            or not set(document).issubset({"value", "ttl_seconds"})
        ):
            self._error(400, "body must contain value and optional ttl_seconds")
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            created = self.store.put(key, document["value"], ttl)  # type: ignore[arg-type]
        except ValueError as exc:
            self._error(400, str(exc))
            return
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "could not persist data")
            return
        self._send_json(201 if created else 200, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        key, error = self._key()
        if error == "invalid":
            self._error(400, "invalid key")
            return
        if error == "route":
            self._error(404, "route not found")
            return
        try:
            deleted = self.store.delete(key)  # type: ignore[arg-type]
        except StoreError as exc:
            self.log_error("%s", exc)
            self._error(500, "could not persist data")
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self._send_empty(204)

    def _unsupported(self) -> None:
        # An unsupported request may carry an unread body. Closing after the
        # response prevents those bytes being parsed as another request.
        self.close_connection = True
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        body = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported
    do_HEAD = _unsupported


class KVServer(ThreadingHTTPServer):
    # Idle keep-alive clients must not prevent SIGINT/SIGTERM from completing.
    daemon_threads = True
    block_on_close = True

    def __init__(self, address: tuple[str, int], store: PersistentStore) -> None:
        self.store = store
        super().__init__(address, KVRequestHandler)


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
        store = PersistentStore(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, StoreError) as exc:
        print(f"server startup failed: {exc}", file=os.sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def stop_server(_signum: int, _frame: Any) -> None:
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
