#!/usr/bin/env python3
"""A small persistent HTTP key-value service."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
KEY_PREFIX = "/v1/kv/"
VALID_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class APIError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Store:
    """Thread-safe store whose mutations are committed to disk before publication."""

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
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                document = json.load(stream, parse_constant=self._reject_constant)
            raw_entries = document["entries"]
            if not isinstance(raw_entries, dict):
                raise ValueError("entries must be an object")
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
                    raise ValueError("invalid expiration in data file")
                loaded[key] = {"value": entry["value"], "expires_at": expires_at}
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        now = time.time()
        live = {key: entry for key, entry in loaded.items() if self._is_live(entry, now)}
        self.entries = live
        if len(live) != len(loaded):
            self._persist(live)

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist(self, entries: dict[str, dict[str, Any]]) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=parent, prefix=f".{self.path.name}.", delete=False
            ) as stream:
                temporary_name = stream.name
                json.dump(
                    {"entries": entries}, stream, ensure_ascii=False, allow_nan=False,
                    separators=(",", ":"), sort_keys=True
                )
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = None
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some filesystems do not support syncing directories. The file
                # itself has still been flushed and atomically replaced.
                pass
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass

    def _without_expired(self, now: float) -> dict[str, dict[str, Any]]:
        return {key: entry for key, entry in self.entries.items() if self._is_live(entry, now)}

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return False, None
            if not self._is_live(entry, time.time()):
                updated = dict(self.entries)
                del updated[key]
                self._persist(updated)
                self.entries = updated
                return False, None
            return True, entry["value"]

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        now = time.time()
        with self.lock:
            updated = self._without_expired(now)
            created = key not in updated
            updated[key] = {
                "value": value,
                "expires_at": None if ttl_seconds is None else now + ttl_seconds,
            }
            self._persist(updated)
            self.entries = updated
            return created

    def delete(self, key: str) -> bool:
        with self.lock:
            updated = self._without_expired(time.time())
            present = key in updated
            if present:
                del updated[key]
            if present or len(updated) != len(self.entries):
                self._persist(updated)
                self.entries = updated
            return present

    def keys(self) -> list[str]:
        with self.lock:
            updated = self._without_expired(time.time())
            if len(updated) != len(self.entries):
                self._persist(updated)
                self.entries = updated
            return sorted(updated)


class KVServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    server: KVServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        # BaseHTTPRequestHandler logs to stderr; retain that behavior explicitly.
        super().log_message(format, *args)

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _target_path(self) -> str:
        try:
            target = urlsplit(self.path)
        except ValueError as exc:
            raise APIError(400, "invalid request target") from exc
        if target.query or target.fragment:
            raise APIError(404, "route not found")
        return target.path

    def _key_for_path(self, path: str) -> str:
        if not path.startswith(KEY_PREFIX):
            raise APIError(404, "route not found")
        encoded = path[len(KEY_PREFIX):]
        if not encoded or VALID_PERCENT_ESCAPE.search(encoded):
            raise APIError(400, "invalid key")
        try:
            # HTTP request lines are decoded as ISO-8859-1 by the stdlib. This
            # conversion also allows correctly encoded raw UTF-8 request targets.
            encoded_bytes = encoded.encode("latin-1")
            key = unquote_to_bytes(encoded_bytes).decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError) as exc:
            raise APIError(400, "key must be valid UTF-8") from exc
        if not key or "/" in key:
            raise APIError(400, "invalid key")
        return key

    def _read_body(self) -> dict[str, Any]:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding is not None:
            raise APIError(400, "transfer encoding is not supported")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise APIError(411, "Content-Length is required")
        try:
            length = int(raw_length, 10)
        except ValueError as exc:
            raise APIError(400, "invalid Content-Length") from exc
        if length < 0:
            raise APIError(400, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            # Consume a bounded prefix before replying.  This avoids resetting
            # ordinary just-over-limit clients while still never buffering or
            # waiting for an attacker-controlled, arbitrarily large body.
            self.rfile.read(min(length, MAX_BODY_BYTES + 1))
            self.close_connection = True
            raise APIError(413, "request body too large")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise APIError(400, "incomplete request body")
        try:
            payload = json.loads(raw, parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise APIError(400, "malformed JSON") from exc
        if not isinstance(payload, dict):
            raise APIError(400, "request body must be a JSON object")
        if "value" not in payload or any(field not in {"value", "ttl_seconds"} for field in payload):
            raise APIError(400, "body must contain value and optional ttl_seconds")
        ttl = payload.get("ttl_seconds")
        if "ttl_seconds" in payload and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            raise APIError(400, "ttl_seconds must be a finite number greater than zero")
        return payload

    def _run(self, operation: Any) -> None:
        try:
            operation()
        except APIError as exc:
            self._send_error(exc.status, exc.message)
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("request failed: %s", exc)
            self._send_error(500, "persistence failure")

    def do_GET(self) -> None:
        self._run(self._do_get)

    def _do_get(self) -> None:
        path = self._target_path()
        if path == "/health":
            self._send_json(200, {"status": "ok"})
        elif path == "/v1/keys":
            self._send_json(200, {"keys": self.server.store.keys()})
        elif path.startswith(KEY_PREFIX):
            key = self._key_for_path(path)
            found, value = self.server.store.get(key)
            if found:
                self._send_json(200, {"key": key, "value": value})
            else:
                self._send_error(404, "key not found")
        else:
            raise APIError(404, "route not found")

    def do_PUT(self) -> None:
        self._run(self._do_put)

    def _do_put(self) -> None:
        key = self._key_for_path(self._target_path())
        payload = self._read_body()
        created = self.server.store.put(key, payload["value"], payload.get("ttl_seconds"))
        self._send_json(201 if created else 200, {"key": key, "value": payload["value"]})

    def do_DELETE(self) -> None:
        self._run(self._do_delete)

    def _do_delete(self) -> None:
        key = self._key_for_path(self._target_path())
        if not self.server.store.delete(key):
            self._send_error(404, "key not found")
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unsupported(self) -> None:
        self._send_error(405, "method not allowed")

    do_POST = _unsupported
    do_PATCH = _unsupported
    do_HEAD = _unsupported
    do_OPTIONS = _unsupported
    do_CONNECT = _unsupported
    do_TRACE = _unsupported

    def __getattr__(self, name: str) -> Any:
        # BaseHTTPRequestHandler uses getattr for method dispatch.  Supplying a
        # fallback keeps extension/unknown methods on the JSON API contract.
        if name.startswith("do_"):
            return self._unsupported
        raise AttributeError(name)


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
        server = KVServer((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"startup failed: {exc}", file=os.sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: Any) -> None:
        if not stopping.is_set():
            stopping.set()
            # shutdown() must run in a different thread from serve_forever().
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
