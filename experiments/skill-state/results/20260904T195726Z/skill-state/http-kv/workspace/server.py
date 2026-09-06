#!/usr/bin/env python3
"""A small persistent HTTP key-value service."""

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
BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(
                self.path.read_text(encoding="utf-8"),
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError(f"invalid JSON constant {value}")
                ),
            )
            if not isinstance(raw, dict) or raw.get("version") != 1:
                raise ValueError("unsupported data file format")
            entries = raw.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("invalid entries in data file")
            now = time.time()
            for key, entry in entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError("invalid entry in data file")
                if "value" not in entry:
                    raise ValueError("entry has no value")
                expires_at = entry.get("expires_at")
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiry in data file")
                if expires_at is None or expires_at > now:
                    self.entries[key] = {
                        "value": entry["value"],
                        "expires_at": expires_at,
                    }
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        # Remove expired records from disk as part of recovery.
        if len(self.entries) != len(entries):
            self._persist_locked()

    def _prune_locked(self) -> bool:
        now = time.time()
        expired = [
            key
            for key, entry in self.entries.items()
            if entry["expires_at"] is not None and entry["expires_at"] <= now
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "entries": self.entries}
        fd, temporary = tempfile.mkstemp(
            prefix=f".{self.path.name}.", dir=self.path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._prune_locked()
            created = key not in self.entries
            expires_at = time.time() + ttl if ttl is not None else None
            self.entries[key] = {"value": value, "expires_at": expires_at}
            self._persist_locked()
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            if self._prune_locked():
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            changed = self._prune_locked()
            present = key in self.entries
            if present:
                del self.entries[key]
                changed = True
            if changed:
                self._persist_locked()
            return present

    def keys(self) -> list[str]:
        with self.lock:
            if self._prune_locked():
                self._persist_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        super().__init__(address, Handler)
        self.store = store


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] " + format % args,
            file=sys.stderr,
        )

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _key(self, path: str) -> str | None:
        encoded = path[len(KEY_PREFIX) :]
        if not encoded or BAD_PERCENT_ESCAPE.search(encoded):
            return None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        if not key or "/" in key:
            return None
        return key

    def _route(self) -> tuple[str, str | None]:
        path = urlsplit(self.path).path
        if path == "/health":
            return "health", None
        if path == "/v1/keys":
            return "keys", None
        if path.startswith(KEY_PREFIX):
            return "key", self._key(path)
        return "unknown", None

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(400, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError:
            raise RequestError(400, "invalid Content-Length") from None
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        try:
            return json.loads(
                body,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError(f"invalid JSON constant {value}")
                ),
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise RequestError(400, "malformed JSON") from None

    def do_GET(self) -> None:
        route, key = self._route()
        if route == "health":
            self._json(200, {"status": "ok"})
        elif route == "keys":
            self._json(200, {"keys": self.server.store.keys()})
        elif route == "key":
            if key is None:
                self._error(400, "invalid key")
                return
            present, value = self.server.store.get(key)
            if present:
                self._json(200, {"key": key, "value": value})
            else:
                self._error(404, "key not found")
        else:
            self._error(404, "route not found")

    def do_PUT(self) -> None:
        route, key = self._route()
        if route != "key":
            self._error(404, "route not found")
            return
        if key is None:
            self._error(400, "invalid key")
            return
        try:
            payload = self._read_json()
        except RequestError as exc:
            self._error(exc.status, exc.message)
            return
        if (
            not isinstance(payload, dict)
            or "value" not in payload
            or not set(payload).issubset({"value", "ttl_seconds"})
        ):
            self._error(400, "body must contain value and optional ttl_seconds")
            return
        ttl = payload.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            created = self.server.store.put(key, payload["value"], ttl)
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("failed to persist data: %s", exc)
            self._error(500, "failed to persist data")
            return
        self._json(201 if created else 200, {"key": key, "value": payload["value"]})

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route != "key":
            self._error(404, "route not found")
            return
        if key is None:
            self._error(400, "invalid key")
            return
        if not self.server.store.delete(key):
            self._error(404, "key not found")
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unsupported(self) -> None:
        route, _ = self._route()
        if route == "unknown":
            self._error(404, "route not found")
        else:
            self._error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        self.status = status
        self.message = message


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
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
        server = Server((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(signum: int, frame: Any) -> None:
        del signum, frame
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
