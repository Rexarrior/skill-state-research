#!/usr/bin/env python3
"""A small, persistent HTTP key-value service using only the standard library."""

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
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                document = json.load(handle)
            raw_entries = document.get("entries") if isinstance(document, dict) else None
            if not isinstance(raw_entries, dict):
                raise ValueError("top-level object must contain an entries object")
            now = time.time()
            cleaned = False
            loaded: dict[str, dict[str, Any]] = {}
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("invalid entry in data file")
                expires_at = entry.get("expires_at")
                if expires_at is not None:
                    if (isinstance(expires_at, bool) or not isinstance(expires_at, (int, float))
                            or not math.isfinite(expires_at)):
                        raise ValueError("invalid expiry in data file")
                    if expires_at <= now:
                        cleaned = True
                        continue
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
            self.entries = loaded
            if cleaned:
                self._persist_locked()
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"entries": self.entries}, handle, ensure_ascii=False,
                          separators=(",", ":"), allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items()
                   if entry["expires_at"] is not None and entry["expires_at"] <= now]
        for key in expired:
            del self.entries[key]
        if expired:
            self._persist_locked()
        return bool(expired)

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked()
            existed = key in self.entries
            previous = self.entries.get(key)
            self.entries[key] = {
                "value": value,
                "expires_at": None if ttl is None else time.time() + ttl,
            }
            try:
                self._persist_locked()
            except BaseException:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return existed

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            self._purge_locked()
            if key not in self.entries:
                return False, None
            return True, self.entries[key]["value"]

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked()
            if key not in self.entries:
                return False
            previous = self.entries.pop(key)
            try:
                self._persist_locked()
            except BaseException:
                self.entries[key] = previous
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
    protocol_version = "HTTP/1.1"

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined]

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"),
                          allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _route(self) -> tuple[str, str | None]:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return "unknown", None
        if parsed.path == "/health":
            return "health", None
        if parsed.path == "/v1/keys":
            return "keys", None
        prefix = "/v1/kv/"
        if not parsed.path.startswith(prefix):
            return "unknown", None
        encoded = parsed.path[len(prefix):]
        if not encoded or "/" in encoded:
            return "bad-key", None
        try:
            raw = unquote_to_bytes(encoded)
            key = raw.decode("utf-8")
        except UnicodeDecodeError:
            return "bad-key", None
        if not key or "/" in key:
            return "bad-key", None
        return "kv", key

    def _read_json(self) -> tuple[bool, Any]:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            self._error(400, "transfer encoding is not supported")
            self.close_connection = True
            return False, None
        length_text = self.headers.get("Content-Length")
        if length_text is None:
            self._error(411, "Content-Length is required")
            return False, None
        try:
            length = int(length_text)
        except ValueError:
            self._error(400, "invalid Content-Length")
            self.close_connection = True
            return False, None
        if length < 0:
            self._error(400, "invalid Content-Length")
            self.close_connection = True
            return False, None
        if length > MAX_BODY:
            self._error(413, "request body exceeds 1 MiB")
            self.close_connection = True
            return False, None
        body = self.rfile.read(length)
        try:
            return True, json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "malformed JSON")
            return False, None

    def do_GET(self) -> None:
        route, key = self._route()
        try:
            if route == "health":
                self._send_json(200, {"status": "ok"})
            elif route == "keys":
                self._send_json(200, {"keys": self.store.keys()})
            elif route == "kv":
                found, value = self.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._send_json(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
            elif route == "bad-key":
                self._error(400, "invalid key")
            else:
                self._error(404, "route not found")
        except (OSError, ValueError) as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "bad-key":
            self._error(400, "invalid key")
            return
        if route != "kv":
            self._error(404, "route not found")
            return
        valid, payload = self._read_json()
        if not valid:
            return
        if not isinstance(payload, dict) or "value" not in payload:
            self._error(400, "body must be an object containing value")
            return
        if any(field not in {"value", "ttl_seconds"} for field in payload):
            self._error(400, "body contains unknown fields")
            return
        ttl = payload.get("ttl_seconds")
        if ttl is not None:
            if (isinstance(ttl, bool) or not isinstance(ttl, (int, float))
                    or not math.isfinite(ttl) or ttl <= 0):
                self._error(400, "ttl_seconds must be finite and greater than zero")
                return
            ttl = float(ttl)
        try:
            replaced = self.store.put(key, payload["value"], ttl)  # type: ignore[arg-type]
            self._send_json(200 if replaced else 201,
                            {"key": key, "value": payload["value"]})
        except (OSError, ValueError) as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "bad-key":
            self._error(400, "invalid key")
            return
        if route != "kv":
            self._error(404, "route not found")
            return
        try:
            if not self.store.delete(key):  # type: ignore[arg-type]
                self._error(404, "key not found")
                return
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except (OSError, ValueError) as exc:
            self.log_error("storage error: %s", exc)
            self._error(500, "storage error")

    def _method_not_allowed(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        body = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_CONNECT = _method_not_allowed
    do_TRACE = _method_not_allowed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
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
        server = Server((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"startup error: {exc}", file=os.sys.stderr, flush=True)
        return 1

    stopping = threading.Event()

    def request_shutdown(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
