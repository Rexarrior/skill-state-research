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
_BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class Store:
    """Thread-safe store whose mutations are committed atomically to disk."""

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
        with self.path.open("r", encoding="utf-8") as source:
            document = json.load(source, parse_constant=_reject_constant)
        if not isinstance(document, dict) or document.get("version") != 1:
            raise ValueError("unsupported data-file format")
        raw_entries = document.get("entries")
        if not isinstance(raw_entries, dict):
            raise ValueError("invalid entries in data file")

        now = time.time()
        discarded = False
        for key, entry in raw_entries.items():
            if not isinstance(key, str) or not key or "/" in key:
                raise ValueError("invalid key in data file")
            if not isinstance(entry, dict) or "value" not in entry:
                raise ValueError("invalid entry in data file")
            expires_at = entry.get("expires_at")
            if expires_at is not None:
                if (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("invalid expiry in data file")
                expires_at = float(expires_at)
            loaded = {"value": entry["value"], "expires_at": expires_at}
            if self._is_live(loaded, now):
                self.entries[key] = loaded
            else:
                discarded = True
        if discarded:
            self._persist()

    def _persist(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        document = {"version": 1, "entries": self.entries}
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_name = temporary.name
                json.dump(
                    document,
                    temporary,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                temporary.write("\n")
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Directory fsync is unavailable on some supported platforms.
                pass
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass

    def _purge_expired(self, now: float) -> bool:
        expired = [
            key for key, entry in self.entries.items() if not self._is_live(entry, now)
        ]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_expired(time.time())
            created = key not in self.entries
            expires_at = None if ttl is None else time.time() + ttl
            previous = self.entries.get(key)
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist()
            except Exception:
                if previous is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            changed = self._purge_expired(time.time())
            if changed:
                self._persist()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_expired(time.time())
            if key not in self.entries:
                return False
            previous = self.entries.pop(key)
            try:
                self._persist()
            except Exception:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_expired(time.time()):
                self._persist()
            return sorted(self.entries)


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def _send(self, status: int, payload: Any | None = None) -> None:
        body = b""
        if payload is not None:
            body = json.dumps(
                payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
            ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send(status, {"error": message})

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        # BaseHTTPRequestHandler uses this for malformed request lines and methods.
        self._error(code, message or self.responses.get(code, ("error",))[0])

    def _parsed_path(self) -> str | None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return None
        return parsed.path

    def _key(self, path: str) -> str | None:
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix) :]
        if not encoded or "/" in encoded or _BAD_ESCAPE.search(encoded):
            return None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        if not key or "/" in key:
            return None
        return key

    def _read_json(self) -> Any:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            raise RequestError(400, "transfer encoding is not supported")
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
        if content_type.lower() != "application/json":
            raise RequestError(415, "Content-Type must be application/json")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestError(411, "Content-Length is required")
        try:
            length = int(raw_length, 10)
        except ValueError:
            raise RequestError(400, "invalid Content-Length") from None
        if length < 0:
            raise RequestError(400, "invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True
            raise RequestError(413, "request body exceeds 1 MiB")
        body = self.rfile.read(length)
        if len(body) != length:
            raise RequestError(400, "incomplete request body")
        try:
            return json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise RequestError(400, "malformed JSON") from None

    def do_GET(self) -> None:
        try:
            path = self._parsed_path()
            if path == "/health":
                self._send(200, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._send(200, {"keys": self.server.store.keys()})
                return
            if path is not None and path.startswith("/v1/kv/"):
                key = self._key(path)
                if key is None:
                    self._error(400, "invalid key")
                    return
                found, value = self.server.store.get(key)
                if found:
                    self._send(200, {"key": key, "value": value})
                else:
                    self._error(404, "key not found")
                return
            self._error(404, "route not found")
        except Exception as exc:
            self._internal_error(exc)

    def do_PUT(self) -> None:
        try:
            path = self._parsed_path()
            if path is None or not path.startswith("/v1/kv/"):
                self._error(404, "route not found")
                return
            key = self._key(path)
            if key is None:
                self._error(400, "invalid key")
                return
            document = self._read_json()
            if not isinstance(document, dict) or "value" not in document:
                raise RequestError(400, "body must be an object containing value")
            unexpected = set(document) - {"value", "ttl_seconds"}
            if unexpected:
                raise RequestError(400, "body contains unsupported fields")
            ttl = document.get("ttl_seconds")
            if "ttl_seconds" in document:
                if (
                    isinstance(ttl, bool)
                    or not isinstance(ttl, (int, float))
                    or not math.isfinite(ttl)
                    or ttl <= 0
                ):
                    raise RequestError(400, "ttl_seconds must be finite and greater than zero")
                ttl = float(ttl)
            created = self.server.store.put(key, document["value"], ttl)
            self._send(201 if created else 200, {"key": key, "value": document["value"]})
        except RequestError as exc:
            self._error(exc.status, exc.message)
        except Exception as exc:
            self._internal_error(exc)

    def do_DELETE(self) -> None:
        try:
            path = self._parsed_path()
            if path is None or not path.startswith("/v1/kv/"):
                self._error(404, "route not found")
                return
            key = self._key(path)
            if key is None:
                self._error(400, "invalid key")
                return
            if self.server.store.delete(key):
                self._send(204)
            else:
                self._error(404, "key not found")
        except Exception as exc:
            self._internal_error(exc)

    def _unsupported(self) -> None:
        self._error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported
    do_TRACE = _unsupported
    do_CONNECT = _unsupported

    def _internal_error(self, exc: Exception) -> None:
        print(f"request failed: {exc}", file=sys.stderr, flush=True)
        try:
            self._error(500, "internal server error")
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - {format % args}",
            file=sys.stderr,
            flush=True,
        )


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--data", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not 0 <= args.port <= 65535:
        print("error: port must be between 0 and 65535", file=sys.stderr)
        return 2
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), store)
    except Exception as exc:
        print(f"startup failed: {exc}", file=sys.stderr, flush=True)
        return 1

    def stop(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    actual_port = server.server_address[1]
    print(f"LISTENING {actual_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
