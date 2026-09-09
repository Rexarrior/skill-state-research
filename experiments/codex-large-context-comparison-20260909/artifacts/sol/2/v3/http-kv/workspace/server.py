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
from urllib.parse import unquote, urlsplit


MAX_BODY = 1024 * 1024
_BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class Store:
    """Thread-safe in-memory state backed by an atomically replaced JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def _is_live(entry: dict[str, Any], now: float) -> bool:
        expires_at = entry["expires_at"]
        return expires_at is None or expires_at > now

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._reject_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported data-file format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("data file has invalid entries")

            now = time.time()
            loaded: dict[str, dict[str, Any]] = {}
            discarded_expired = False
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("data file contains an invalid key")
                if not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("data file contains an invalid entry")
                expires_at = entry["expires_at"]
                if expires_at is not None and (
                    isinstance(expires_at, bool)
                    or not isinstance(expires_at, (int, float))
                    or not math.isfinite(expires_at)
                ):
                    raise ValueError("data file contains an invalid expiration")
                normalized = {"value": entry["value"], "expires_at": expires_at}
                if self._is_live(normalized, now):
                    loaded[key] = normalized
                else:
                    discarded_expired = True
            self.entries = loaded
            if discarded_expired:
                self._persist_locked()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

    @staticmethod
    def _reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON number {value}")

    def _purge_locked(self, now: float) -> bool:
        expired = [key for key, entry in self.entries.items() if not self._is_live(entry, now)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _persist_locked(self) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(
                    {"version": 1, "entries": self.entries},
                    output,
                    # ASCII escaping also handles JSON strings containing lone
                    # surrogate code points without depending on the file
                    # system's UTF-8 encoder accepting them.
                    ensure_ascii=True,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_name, self.path)
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                # Some filesystems do not support syncing directories.
                pass
        except BaseException:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
            raise

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked(time.time())
            created = key not in self.entries
            previous = self.entries.get(key)
            expires_at = None if ttl is None else time.time() + ttl
            self.entries[key] = {"value": value, "expires_at": expires_at}
            try:
                self._persist_locked()
            except BaseException:
                if previous is None:
                    self.entries.pop(key, None)
                else:
                    self.entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self.lock:
            changed = self._purge_locked(time.time())
            if changed:
                self._try_persist_cleanup()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_locked(time.time())
            previous = self.entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist_locked()
            except BaseException:
                self.entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self.lock:
            changed = self._purge_locked(time.time())
            if changed:
                self._try_persist_cleanup()
            return sorted(self.entries)

    def _try_persist_cleanup(self) -> None:
        try:
            self._persist_locked()
        except OSError as exc:
            print(f"warning: could not persist expiration cleanup: {exc}", file=sys.stderr)


class KVServer(ThreadingHTTPServer):
    # A client holding an idle keep-alive connection must not prevent SIGTERM
    # from completing the shutdown.
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"

    @property
    def kv_server(self) -> KVServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"{self.address_string()} - [{self.log_date_time_string()}] "
            + (format_string % args),
            file=sys.stderr,
        )

    def _json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(
            payload, ensure_ascii=True, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    def _empty_json(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        del explain
        self._error(code, message or self.responses.get(code, ("Error",))[0])

    def _route_key(self) -> tuple[str | None, str | None]:
        try:
            raw_path = urlsplit(self.path).path
        except ValueError:
            return None, "invalid request path"
        prefix = "/v1/kv/"
        if not raw_path.startswith(prefix):
            return None, None
        encoded_key = raw_path[len(prefix) :]
        if "/" in encoded_key or _BAD_PERCENT_ESCAPE.search(encoded_key):
            return None, "invalid key"
        try:
            key = unquote(encoded_key, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return None, "key is not valid UTF-8"
        if not key or "/" in key:
            return None, "invalid key"
        return key, ""

    def _content_length(self) -> int | None:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            self._error(400, "transfer encoding is not supported")
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self.close_connection = True
            self._error(411, "Content-Length is required")
            return None
        try:
            length = int(raw_length, 10)
        except ValueError:
            self.close_connection = True
            self._error(400, "invalid Content-Length")
            return None
        if length < 0:
            self.close_connection = True
            self._error(400, "invalid Content-Length")
            return None
        if length > MAX_BODY:
            self.close_connection = True
            self._error(413, "request body exceeds 1 MiB")
            return None
        return length

    def _read_json(self) -> tuple[bool, Any]:
        length = self._content_length()
        if length is None:
            return False, None
        try:
            raw = self.rfile.read(length)
            value = json.loads(raw.decode("utf-8"), parse_constant=Store._reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
            self._error(400, "malformed JSON")
            return False, None
        return True, value

    def do_GET(self) -> None:
        try:
            path = urlsplit(self.path).path
        except ValueError:
            self._error(400, "invalid request path")
            return
        if path == "/health":
            self._json(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            self._json(200, {"keys": self.kv_server.store.keys()})
            return
        key, route_state = self._route_key()
        if route_state is None:
            self._error(404, "route not found")
        elif route_state:
            self._error(400, route_state)
        else:
            found, value = self.kv_server.store.get(key)  # type: ignore[arg-type]
            if found:
                self._json(200, {"key": key, "value": value})
            else:
                self._error(404, "key not found")

    def do_PUT(self) -> None:
        key, route_state = self._route_key()
        if route_state is None:
            self._error(404, "route not found")
            return
        if route_state:
            self._error(400, route_state)
            return
        ok, document = self._read_json()
        if not ok:
            return
        if not isinstance(document, dict) or "value" not in document or not set(document) <= {
            "value",
            "ttl_seconds",
        }:
            self._error(400, "body must be an object containing value and optional ttl_seconds")
            return
        ttl = document.get("ttl_seconds")
        if "ttl_seconds" in document and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            created = self.kv_server.store.put(key, document["value"], ttl)
        except (OSError, TypeError, ValueError) as exc:
            self.log_error("persistence error: %s", exc)
            self._error(500, "could not persist data")
            return
        self._json(201 if created else 200, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        key, route_state = self._route_key()
        if route_state is None:
            self._error(404, "route not found")
            return
        if route_state:
            self._error(400, route_state)
            return
        try:
            deleted = self.kv_server.store.delete(key)  # type: ignore[arg-type]
        except OSError as exc:
            self.log_error("persistence error: %s", exc)
            self._error(500, "could not persist data")
            return
        if deleted:
            self._empty_json(204)
        else:
            self._error(404, "key not found")

    def _method_not_allowed(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, PUT, DELETE")
        encoded = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(encoded)

    do_POST = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_CONNECT = _method_not_allowed
    do_TRACE = _method_not_allowed

    def __getattr__(self, name: str) -> Any:
        if name.startswith("do_"):
            return self._method_not_allowed
        raise AttributeError(name)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
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
        server = KVServer((args.host, args.port), store)
    except (OSError, RuntimeError) as exc:
        print(f"startup error: {exc}", file=sys.stderr)
        return 1

    def stop(_signum: int, _frame: Any) -> None:
        # HTTPServer.shutdown must run outside the serve_forever thread.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    print(f"LISTENING {server.server_address[1]}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
