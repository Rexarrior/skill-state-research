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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024
KEY_PREFIX = "/v1/kv/"


class Store:
    def __init__(self, filename: str) -> None:
        self.path = Path(filename).resolve()
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
            if not isinstance(raw, dict) or raw.get("version") != 1:
                raise ValueError("unsupported data-file format")
            entries = raw.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("invalid entries in data file")
            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            for key, record in entries.items():
                if not isinstance(key, str) or not isinstance(record, dict) or "value" not in record:
                    raise ValueError("invalid entry in data file")
                expires = record.get("expires_at")
                if expires is not None:
                    if isinstance(expires, bool) or not isinstance(expires, (int, float)) or not math.isfinite(expires):
                        raise ValueError("invalid expiration in data file")
                    if expires <= now:
                        continue
                loaded[key] = {"value": record["value"], "expires_at": expires}
            self.entries = loaded
            if len(loaded) != len(entries):
                self._persist_locked()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "entries": self.entries}
        temporary: str | None = None
        try:
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            temporary = None
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [key for key, record in self.entries.items()
                   if record["expires_at"] is not None and record["expires_at"] <= now]
        for key in expired:
            del self.entries[key]
        if expired:
            self._persist_locked()
        return bool(expired)

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked()
            created = key not in self.entries
            expires = None if ttl is None else time.time() + ttl
            old = self.entries.get(key)
            self.entries[key] = {"value": value, "expires_at": expires}
            try:
                self._persist_locked()
            except Exception:
                if old is None:
                    del self.entries[key]
                else:
                    self.entries[key] = old
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._purge_locked()
            record = self.entries.get(key)
            return (False, None) if record is None else (True, record["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked()
            old = self.entries.pop(key, None)
            if old is None:
                return False
            try:
                self._persist_locked()
            except Exception:
                self.entries[key] = old
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._purge_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store):
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _path(self) -> str:
        try:
            return urlsplit(self.path).path
        except ValueError:
            return ""

    def _key(self) -> tuple[str | None, str | None]:
        path = self._path()
        if not path.startswith(KEY_PREFIX):
            return None, "unknown route"
        encoded = path[len(KEY_PREFIX):]
        if not encoded or "/" in encoded:
            return None, "invalid key"
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                if index + 2 >= len(encoded) or any(ch not in "0123456789abcdefABCDEF" for ch in encoded[index + 1:index + 3]):
                    return None, "invalid key encoding"
                index += 3
            else:
                index += 1
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            return None, "key must be UTF-8"
        if not key or "/" in key:
            return None, "invalid key"
        return key, None

    def _read_json(self) -> tuple[Any | None, bool]:
        if self.headers.get("Transfer-Encoding") is not None:
            self._error(400, "transfer encoding is not supported")
            return None, False
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "Content-Length is required")
            return None, False
        try:
            length = int(raw_length)
        except ValueError:
            self._error(400, "invalid Content-Length")
            return None, False
        if length < 0:
            self._error(400, "invalid Content-Length")
            return None, False
        if length > MAX_BODY:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return None, False
        raw = self.rfile.read(length)
        try:
            return json.loads(raw), True
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._error(400, "malformed JSON")
            return None, False

    def do_GET(self) -> None:
        path = self._path()
        try:
            if path == "/health":
                self._json(200, {"status": "ok"})
            elif path == "/v1/keys":
                self._json(200, {"keys": self.server.store.keys()})
            elif path.startswith(KEY_PREFIX):
                key, error = self._key()
                if error:
                    self._error(400, error)
                    return
                found, value = self.server.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            else:
                self._error(404, "unknown route")
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._error(500, "internal server error")

    def do_PUT(self) -> None:
        key, error = self._key()
        if error:
            self._error(404 if error == "unknown route" else 400, error)
            return
        body, ok = self._read_json()
        if not ok:
            return
        if not isinstance(body, dict) or "value" not in body or any(field not in {"value", "ttl_seconds"} for field in body):
            self._error(400, "body must be an object containing value and optional ttl_seconds")
            return
        ttl = body.get("ttl_seconds")
        if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0):
            self._error(400, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.server.store.put(key, body["value"], ttl)  # type: ignore[arg-type]
            self._json(201 if created else 200, {"key": key, "value": body["value"]})
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("persistence failed: %s", exc)
            self._error(500, "internal server error")

    def do_DELETE(self) -> None:
        key, error = self._key()
        if error:
            self._error(404 if error == "unknown route" else 400, error)
            return
        try:
            if not self.server.store.delete(key):  # type: ignore[arg-type]
                self._error(404, "key not found")
                return
            self.send_response(204)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except OSError as exc:
            self.log_error("persistence failed: %s", exc)
            self._error(500, "internal server error")

    def _unsupported(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), store)
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
