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


class Store:
    """Thread-safe in-memory state backed by an atomically replaced JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as stream:
            document = json.load(stream, parse_constant=self._invalid_constant)
        if not isinstance(document, dict) or document.get("version") != 1:
            raise ValueError("unsupported data-file format")
        raw_entries = document.get("entries")
        if not isinstance(raw_entries, dict):
            raise ValueError("invalid data-file entries")
        loaded: dict[str, dict[str, Any]] = {}
        for key, entry in raw_entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise ValueError("invalid key in data file")
            if not isinstance(entry, dict) or "value" not in entry:
                raise ValueError("invalid entry in data file")
            expires_at = entry.get("expires_at")
            if expires_at is not None and (
                isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or not math.isfinite(expires_at)
            ):
                raise ValueError("invalid expiry in data file")
            loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        self.entries = loaded
        with self.lock:
            if self._purge_locked(time.time()):
                self._persist_locked()

    @staticmethod
    def _invalid_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    def _purge_locked(self, now: float) -> bool:
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
        document = {"version": 1, "entries": self.entries}
        fd, temporary = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(
                    document,
                    stream,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            try:
                directory_fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some platforms/filesystems do not support fsync on directories.
                pass
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked(time.time())
            created = key not in self.entries
            expires_at = None if ttl is None else time.time() + ttl
            previous = self.entries.get(key)
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except BaseException:
                if previous is None:
                    del self.entries[key]
                else:
                    self.entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            changed = self._purge_locked(time.time())
            if changed:
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            changed = self._purge_locked(time.time())
            if key not in self.entries:
                if changed:
                    self._persist_locked()
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
            if self._purge_locked(time.time()):
                self._persist_locked()
            return sorted(self.entries)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", file=sys.stderr)

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        del explain
        self._json(code, {"error": message or self.responses.get(code, ("error",))[0]})

    def _json(self, status: int, value: Any | None = None) -> None:
        body = b"" if status == 204 else json.dumps(
            value, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _key(self) -> tuple[str | None, str | None]:
        path = self._path()
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None, "unknown route"
        encoded = path[len(prefix) :]
        if not encoded:
            return None, "key must not be empty"
        index = 0
        while index < len(encoded):
            if encoded[index] == "%":
                if index + 2 >= len(encoded) or any(
                    char not in "0123456789abcdefABCDEF" for char in encoded[index + 1 : index + 3]
                ):
                    return None, "invalid URL encoding"
                index += 3
            else:
                index += 1
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            return None, "key must be valid UTF-8"
        if not key:
            return None, "key must not be empty"
        if "/" in key:
            return None, "key must not contain '/'"
        return key, None

    def _read_json(self) -> tuple[Any | None, str | None]:
        if self.headers.get("Transfer-Encoding") is not None:
            return None, "transfer encoding is not supported"
        length_text = self.headers.get("Content-Length")
        if length_text is None:
            return None, "Content-Length is required"
        try:
            length = int(length_text, 10)
        except ValueError:
            return None, "invalid Content-Length"
        if length < 0:
            return None, "invalid Content-Length"
        if length > MAX_BODY:
            return None, "request body exceeds 1 MiB"
        raw = self.rfile.read(length)
        if len(raw) != length:
            return None, "incomplete request body"
        try:
            return json.loads(raw, parse_constant=Store._invalid_constant), None
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            return None, "malformed JSON"

    def do_GET(self) -> None:
        path = self._path()
        try:
            if path == "/health":
                self._json(200, {"status": "ok"})
            elif path == "/v1/keys":
                self._json(200, {"keys": self.server.store.keys()})
            elif path.startswith("/v1/kv/"):
                key, error = self._key()
                if error:
                    self._json(400, {"error": error})
                    return
                found, value = self.server.store.get(key)  # type: ignore[arg-type]
                if found:
                    self._json(200, {"key": key, "value": value})
                else:
                    self._json(404, {"error": "key not found"})
            else:
                self._json(404, {"error": "unknown route"})
        except OSError as exc:
            self.log_error("storage error: %s", exc)
            self._json(500, {"error": "storage error"})

    def do_PUT(self) -> None:
        key, error = self._key()
        if error:
            self._json(400 if self._path().startswith("/v1/kv/") else 404, {"error": error})
            return
        document, error = self._read_json()
        if error:
            self._json(413 if "exceeds" in error else 400, {"error": error})
            return
        if not isinstance(document, dict) or "value" not in document:
            self._json(400, {"error": "body must be an object containing value"})
            return
        if any(field not in {"value", "ttl_seconds"} for field in document):
            self._json(400, {"error": "unknown body field"})
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._json(400, {"error": "ttl_seconds must be finite and greater than zero"})
            return
        try:
            created = self.server.store.put(key, document["value"], ttl)  # type: ignore[arg-type]
            self._json(201 if created else 200, {"key": key, "value": document["value"]})
        except (OSError, ValueError) as exc:
            self.log_error("storage error: %s", exc)
            self._json(500, {"error": "storage error"})

    def do_DELETE(self) -> None:
        key, error = self._key()
        if error:
            self._json(400 if self._path().startswith("/v1/kv/") else 404, {"error": error})
            return
        try:
            if self.server.store.delete(key):  # type: ignore[arg-type]
                self._json(204)
            else:
                self._json(404, {"error": "key not found"})
        except OSError as exc:
            self.log_error("storage error: %s", exc)
            self._json(500, {"error": "storage error"})

    def _method_not_allowed(self) -> None:
        self._json(405, {"error": "method not allowed"})

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_CONNECT = _method_not_allowed
    do_TRACE = _method_not_allowed


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
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"startup error: {exc}", file=sys.stderr)
        return 1

    stopping = False

    def stop(signum: int, frame: Any) -> None:
        nonlocal stopping
        del signum, frame
        if not stopping:
            stopping = True
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
