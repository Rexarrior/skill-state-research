#!/usr/bin/env python3
"""Persistent dependency-free HTTP key-value service."""

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
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
            if not isinstance(raw, dict):
                raise ValueError("data file root must be an object")
            now = time.time()
            for key, entry in raw.items():
                if (
                    isinstance(key, str)
                    and key
                    and "/" not in key
                    and isinstance(entry, dict)
                    and "value" in entry
                    and (entry.get("expires_at") is None or self._valid_expiry(entry.get("expires_at")))
                    and (entry.get("expires_at") is None or entry["expires_at"] > now)
                ):
                    self.entries[key] = {
                        "value": entry["value"],
                        "expires_at": entry.get("expires_at"),
                    }
            if len(self.entries) != len(raw):
                self._persist()
        except FileNotFoundError:
            return
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _valid_expiry(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    def _purge(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items()
                   if entry["expires_at"] is not None and entry["expires_at"] <= now]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(self.entries, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            changed = self._purge()
            created = key not in self.entries
            self.entries[key] = {
                "value": value,
                "expires_at": time.time() + ttl if ttl is not None else None,
            }
            self._persist()
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            if self._purge():
                self._persist()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            changed = self._purge()
            existed = key in self.entries
            if existed:
                del self.entries[key]
            if changed or existed:
                self._persist()
            return existed

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge():
                self._persist()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: Store):
        super().__init__(address, Handler)
        self.store = store


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def _send(self, status: int, payload: Any | None = None) -> None:
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        if payload is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send(status, {"error": message})

    def _path(self) -> str | None:
        try:
            return urlsplit(self.path).path
        except ValueError:
            self._error(400, "invalid URL")
            return None

    def _key(self, path: str) -> str | None:
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix):]
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            self._error(400, "key must be valid UTF-8")
            return ""
        if not key or "/" in key:
            self._error(400, "key must be non-empty and cannot contain '/'")
            return ""
        return key

    def _json_body(self) -> Any:
        length_text = self.headers.get("Content-Length")
        if length_text is None:
            self._error(411, "Content-Length is required")
            return None
        try:
            length = int(length_text)
        except ValueError:
            self._error(400, "invalid Content-Length")
            return None
        if length < 0:
            self._error(400, "invalid Content-Length")
            return None
        if length > MAX_BODY:
            self._error(413, "request body exceeds 1 MiB")
            self.close_connection = True
            return None
        try:
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "malformed JSON")
            return None

    def do_GET(self) -> None:
        path = self._path()
        if path is None:
            return
        if path == "/health":
            self._send(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            self._send(200, {"keys": self.store.keys()})
            return
        key = self._key(path)
        if key is None:
            self._error(404, "route not found")
        elif key:
            found, value = self.store.get(key)
            if found:
                self._send(200, {"key": key, "value": value})
            else:
                self._error(404, "key not found")

    def do_PUT(self) -> None:
        path = self._path()
        if path is None:
            return
        key = self._key(path)
        if key is None:
            self._error(404, "route not found")
            return
        if not key:
            return
        payload = self._json_body()
        if payload is None:
            return
        if not isinstance(payload, dict) or "value" not in payload or not set(payload).issubset({"value", "ttl_seconds"}):
            self._error(400, "body must be an object containing value and optional ttl_seconds")
            return
        ttl = payload.get("ttl_seconds")
        if ttl is not None and (
            not isinstance(ttl, (int, float)) or isinstance(ttl, bool) or not math.isfinite(ttl) or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be finite and greater than zero")
            return
        try:
            created = self.store.put(key, payload["value"], float(ttl) if ttl is not None else None)
        except (OSError, ValueError) as exc:
            self.log_error("persistence failed: %s", exc)
            self._error(500, "persistence failed")
            return
        self._send(201 if created else 200, {"key": key, "value": payload["value"]})

    def do_DELETE(self) -> None:
        path = self._path()
        if path is None:
            return
        key = self._key(path)
        if key is None:
            self._error(404, "route not found")
        elif key:
            if self.store.delete(key):
                self._send(204)
            else:
                self._error(404, "key not found")

    def _unsupported(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_OPTIONS = _unsupported


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
        server = Server((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    def stop(_signum: int, _frame: Any) -> None:
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
