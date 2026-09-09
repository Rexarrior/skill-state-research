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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024


class Store:
    """Lock-protected store persisted with atomic file replacement."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry.get("expires_at")
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle)
        except FileNotFoundError:
            return
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        if not isinstance(document, dict) or document.get("version") != 1:
            raise RuntimeError(f"invalid data file {self.path}")
        entries = document.get("entries")
        if not isinstance(entries, dict):
            raise RuntimeError(f"invalid data file {self.path}")

        now = time.time()
        loaded: dict[str, dict[str, Any]] = {}
        for key, entry in entries.items():
            if not isinstance(key, str) or not isinstance(entry, dict) or "value" not in entry:
                raise RuntimeError(f"invalid data file {self.path}")
            expires_at = entry.get("expires_at")
            if expires_at is not None and (
                not isinstance(expires_at, (int, float))
                or isinstance(expires_at, bool)
                or not math.isfinite(expires_at)
            ):
                raise RuntimeError(f"invalid data file {self.path}")
            normalized = {"value": entry["value"], "expires_at": expires_at}
            if self._live(normalized, now):
                loaded[key] = normalized
        self.entries = loaded
        if len(loaded) != len(entries):
            self._persist_locked()

    def _purge_locked(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "entries": self.entries}
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            now = time.time()
            self._purge_locked(now)
            created = key not in self.entries
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl is None else now + ttl,
            }
            self._persist_locked()
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            now = time.time()
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if not self._live(entry, now):
                del self.entries[key]
                self._persist_locked()
                return False, None
            return True, entry["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            now = time.time()
            changed = self._purge_locked(now)
            present = key in self.entries
            if present:
                del self.entries[key]
                changed = True
            if changed:
                self._persist_locked()
            return present

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_locked(time.time()):
                self._persist_locked()
            return sorted(self.entries)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))

    def _json(self, status: int, value: Any) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _key(self) -> tuple[str | None, str | None]:
        path = self._path()
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None, "unknown route"
        encoded = path[len(prefix) :]
        if not encoded or "/" in encoded:
            return None, "invalid key"
        try:
            raw = unquote_to_bytes(encoded)
            key = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None, "invalid key"
        if not key or "/" in key:
            return None, "invalid key"
        return key, None

    def _read_document(self) -> tuple[dict[str, Any] | None, str | None, int]:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            return None, "unsupported transfer encoding", 400
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return None, "Content-Length required", 411
        try:
            length = int(raw_length, 10)
        except ValueError:
            return None, "invalid Content-Length", 400
        if length < 0:
            return None, "invalid Content-Length", 400
        if length > MAX_BODY:
            return None, "request body too large", 413
        body = self.rfile.read(length)
        try:
            document = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, "malformed JSON", 400
        if not isinstance(document, dict):
            return None, "body must be a JSON object", 400
        return document, None, 0

    def do_GET(self) -> None:
        path = self._path()
        if path == "/health":
            self._json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            try:
                self._json(200, {"keys": self.server.store.keys()})
            except OSError:
                self.log_error("could not persist expired-entry cleanup")
                self._error(500, "internal server error")
            return
        key, error = self._key()
        if error:
            self._error(404 if error == "unknown route" else 400, error)
            return
        try:
            present, value = self.server.store.get(key)
        except OSError:
            self.log_error("could not persist expired-entry cleanup")
            self._error(500, "internal server error")
            return
        if not present:
            self._error(404, "key not found")
        else:
            self._json(200, {"key": key, "value": value})

    def do_PUT(self) -> None:
        key, error = self._key()
        if error:
            self._error(404 if error == "unknown route" else 400, error)
            return
        document, error, status = self._read_document()
        if error:
            self._error(status, error)
            return
        assert document is not None
        if "value" not in document or any(name not in {"value", "ttl_seconds"} for name in document):
            self._error(400, "body must contain value and optional ttl_seconds only")
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None and (
            not isinstance(ttl, (int, float))
            or isinstance(ttl, bool)
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            created = self.server.store.put(key, document["value"], ttl)
        except (OSError, ValueError):
            self.log_error("could not persist value")
            self._error(500, "internal server error")
            return
        self._json(201 if created else 200, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        key, error = self._key()
        if error:
            self._error(404 if error == "unknown route" else 400, error)
            return
        try:
            deleted = self.server.store.delete(key)
        except OSError:
            self.log_error("could not persist deletion")
            self._error(500, "internal server error")
            return
        if deleted:
            self._empty(204)
        else:
            self._error(404, "key not found")

    def _unsupported(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported
    do_HEAD = _unsupported


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
        server = KVServer((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
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
