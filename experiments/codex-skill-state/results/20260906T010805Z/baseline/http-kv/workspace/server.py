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
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024
HEX_DIGITS = frozenset("0123456789abcdefABCDEF")


class ClientError(Exception):
    """An error caused by an invalid request."""

    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Entry:
    value: Any
    expires_at: float | None


class Store:
    """Thread-safe in-memory state backed by an atomically replaced JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._entries: dict[str, Entry] = {}
        self._load()

    @staticmethod
    def _is_expired(entry: Entry, now: float) -> bool:
        return entry.expires_at is not None and entry.expires_at <= now

    def _prune_locked(self, now: float) -> bool:
        expired = [
            key for key, entry in self._entries.items()
            if self._is_expired(entry, now)
        ]
        for key in expired:
            del self._entries[key]
        return bool(expired)

    def _load(self) -> None:
        if not self.path.exists():
            return

        try:
            with self.path.open("r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._invalid_constant)
            if not isinstance(document, dict) or document.get("version") != 1:
                raise ValueError("unsupported persistence format")
            raw_entries = document.get("entries")
            if not isinstance(raw_entries, dict):
                raise ValueError("persistence entries must be an object")

            loaded: dict[str, Entry] = {}
            for key, raw_entry in raw_entries.items():
                if not isinstance(key, str) or not key or "/" in key:
                    raise ValueError("persistence file contains an invalid key")
                if not isinstance(raw_entry, dict):
                    raise ValueError("persistence file contains an invalid entry")
                if set(raw_entry) != {"value", "expires_at"}:
                    raise ValueError("persistence file contains an invalid entry")
                expires_at = raw_entry["expires_at"]
                if expires_at is not None:
                    if (
                        isinstance(expires_at, bool)
                        or not isinstance(expires_at, (int, float))
                        or not math.isfinite(expires_at)
                    ):
                        raise ValueError("persistence file contains an invalid expiry")
                    expires_at = float(expires_at)
                loaded[key] = Entry(raw_entry["value"], expires_at)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
            raise RuntimeError(f"cannot load data file {self.path}: {error}") from error

        self._entries = loaded
        if self._prune_locked(time.time()):
            self._persist_locked()

    @staticmethod
    def _invalid_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        document = {
            "version": 1,
            "entries": {
                key: {"value": entry.value, "expires_at": entry.expires_at}
                for key, entry in self._entries.items()
            },
        }

        temp_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as destination:
                temp_path = destination.name
                json.dump(
                    document,
                    destination,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
                destination.write("\n")
                destination.flush()
                os.fsync(destination.fileno())
            os.replace(temp_path, self.path)
            temp_path = None
            self._sync_directory()
        finally:
            if temp_path is not None:
                try:
                    os.unlink(temp_path)
                except FileNotFoundError:
                    pass

    def _sync_directory(self) -> None:
        """Best-effort durability for the rename itself."""
        flags = os.O_RDONLY
        if hasattr(os, "O_DIRECTORY"):
            flags |= os.O_DIRECTORY
        try:
            directory_fd = os.open(self.path.parent, flags)
        except OSError:
            return
        try:
            os.fsync(directory_fd)
        except OSError:
            pass
        finally:
            os.close(directory_fd)

    def put(self, key: str, value: Any, ttl_seconds: int | float | None) -> bool:
        with self._lock:
            now = time.time()
            self._prune_locked(now)
            created = key not in self._entries
            expires_at = None if ttl_seconds is None else now + float(ttl_seconds)
            previous = self._entries.get(key)
            self._entries[key] = Entry(value, expires_at)
            try:
                self._persist_locked()
            except Exception:
                if previous is None:
                    del self._entries[key]
                else:
                    self._entries[key] = previous
                raise
            return created

    def get(self, key: str) -> tuple[bool, Any]:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            if self._is_expired(entry, time.time()):
                del self._entries[key]
                self._persist_expiry_cleanup()
                return False, None
            return True, entry.value

    def delete(self, key: str) -> bool:
        with self._lock:
            now = time.time()
            self._prune_locked(now)
            previous = self._entries.pop(key, None)
            if previous is None:
                return False
            try:
                self._persist_locked()
            except Exception:
                self._entries[key] = previous
                raise
            return True

    def keys(self) -> list[str]:
        with self._lock:
            changed = self._prune_locked(time.time())
            if changed:
                self._persist_expiry_cleanup()
            return sorted(self._entries)

    def _persist_expiry_cleanup(self) -> None:
        try:
            self._persist_locked()
        except OSError as error:
            print(f"failed to persist expiry cleanup: {error}", file=sys.stderr)


class KVServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store) -> None:
        self.store = store
        super().__init__(address, RequestHandler)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PersistentKV/1.0"
    sys_version = ""

    @property
    def kv_server(self) -> KVServer:
        return self.server  # type: ignore[return-value]

    def __getattr__(self, name: str) -> Any:
        if name.startswith("do_"):
            return self._method_not_allowed
        raise AttributeError(name)

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"{self.client_address[0]} - {format_string % args}",
            file=sys.stderr,
        )

    def send_error(
        self,
        code: int,
        message: str | None = None,
        explain: str | None = None,
    ) -> None:
        del explain
        try:
            status = HTTPStatus(code)
            default_message = status.phrase
        except ValueError:
            default_message = "HTTP error"
        self._send_json(code, {"error": message or default_message})

    def _send_json(self, status: int | HTTPStatus, body: Any) -> None:
        payload = json.dumps(
            body,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _send_empty(self, status: int | HTTPStatus) -> None:
        self.send_response(int(status))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _route_path(self) -> str:
        try:
            return urlsplit(self.path).path
        except ValueError as error:
            raise ClientError(HTTPStatus.BAD_REQUEST, "invalid request target") from error

    def _key_from_path(self, path: str) -> str | None:
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix):]
        if "/" in encoded:
            raise ClientError(HTTPStatus.BAD_REQUEST, "key must not contain '/'")
        for index, character in enumerate(encoded):
            if character == "%" and (
                index + 2 >= len(encoded)
                or encoded[index + 1] not in HEX_DIGITS
                or encoded[index + 2] not in HEX_DIGITS
            ):
                raise ClientError(HTTPStatus.BAD_REQUEST, "key has invalid URL encoding")
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError as error:
            raise ClientError(HTTPStatus.BAD_REQUEST, "key is not valid UTF-8") from error
        if not key:
            raise ClientError(HTTPStatus.BAD_REQUEST, "key must not be empty")
        if "/" in key:
            raise ClientError(HTTPStatus.BAD_REQUEST, "key must not contain '/'")
        return key

    def _read_json_body(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            self.close_connection = True
            raise ClientError(
                HTTPStatus.BAD_REQUEST,
                "Transfer-Encoding is not supported",
            )
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise ClientError(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
        if not raw_length.isascii() or not raw_length.isdigit():
            self.close_connection = True
            raise ClientError(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
        try:
            length = int(raw_length, 10)
        except (ValueError, OverflowError) as error:
            self.close_connection = True
            raise ClientError(HTTPStatus.BAD_REQUEST, "invalid Content-Length") from error
        if length > MAX_BODY_BYTES:
            # Consume a modest overage so ordinary clients can finish sending and
            # receive the 413 response instead of racing a closed TCP socket.
            # The cap avoids trusting an arbitrarily large declared length.
            self.rfile.read(min(length, MAX_BODY_BYTES + 64 * 1024))
            self.close_connection = True
            raise ClientError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "request body exceeds 1 MiB",
            )
        payload = self.rfile.read(length)
        if len(payload) != length:
            self.close_connection = True
            raise ClientError(HTTPStatus.BAD_REQUEST, "incomplete request body")
        try:
            text = payload.decode("utf-8")
            return json.loads(text, parse_constant=Store._invalid_constant)
        except (
            UnicodeDecodeError,
            json.JSONDecodeError,
            ValueError,
            RecursionError,
        ) as error:
            raise ClientError(HTTPStatus.BAD_REQUEST, "malformed JSON") from error

    def do_GET(self) -> None:
        try:
            path = self._route_path()
            if path == "/health":
                self._send_json(HTTPStatus.OK, {"status": "ok"})
                return
            if path == "/v1/keys":
                self._send_json(
                    HTTPStatus.OK,
                    {"keys": self.kv_server.store.keys()},
                )
                return
            key = self._key_from_path(path)
            if key is None:
                raise ClientError(HTTPStatus.NOT_FOUND, "route not found")
            found, value = self.kv_server.store.get(key)
            if not found:
                raise ClientError(HTTPStatus.NOT_FOUND, "key not found")
            self._send_json(HTTPStatus.OK, {"key": key, "value": value})
        except ClientError as error:
            self._send_json(error.status, {"error": error.message})
        except OSError as error:
            self.log_error("storage error: %s", error)
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "storage error"})

    def do_PUT(self) -> None:
        try:
            body = self._read_json_body()
            path = self._route_path()
            key = self._key_from_path(path)
            if key is None:
                raise ClientError(HTTPStatus.NOT_FOUND, "route not found")
            if not isinstance(body, dict):
                raise ClientError(HTTPStatus.BAD_REQUEST, "body must be a JSON object")
            if "value" not in body or not set(body).issubset({"value", "ttl_seconds"}):
                raise ClientError(
                    HTTPStatus.BAD_REQUEST,
                    "body must contain value and optional ttl_seconds only",
                )
            ttl = body.get("ttl_seconds")
            if "ttl_seconds" in body:
                if (
                    isinstance(ttl, bool)
                    or not isinstance(ttl, (int, float))
                ):
                    raise ClientError(
                        HTTPStatus.BAD_REQUEST,
                        "ttl_seconds must be a finite number greater than zero",
                    )
                try:
                    valid_ttl = math.isfinite(ttl) and ttl > 0
                    valid_expiry = math.isfinite(time.time() + float(ttl))
                except (OverflowError, TypeError):
                    valid_ttl = valid_expiry = False
                if not valid_ttl or not valid_expiry:
                    raise ClientError(
                        HTTPStatus.BAD_REQUEST,
                        "ttl_seconds must be a finite number greater than zero",
                    )
            created = self.kv_server.store.put(key, body["value"], ttl)
            self._send_json(
                HTTPStatus.CREATED if created else HTTPStatus.OK,
                {"key": key, "value": body["value"]},
            )
        except ClientError as error:
            self._send_json(error.status, {"error": error.message})
        except (OSError, ValueError) as error:
            self.log_error("storage error: %s", error)
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "storage error"})

    def do_DELETE(self) -> None:
        try:
            path = self._route_path()
            key = self._key_from_path(path)
            if key is None:
                raise ClientError(HTTPStatus.NOT_FOUND, "route not found")
            if not self.kv_server.store.delete(key):
                raise ClientError(HTTPStatus.NOT_FOUND, "key not found")
            self._send_empty(HTTPStatus.NO_CONTENT)
        except ClientError as error:
            self._send_json(error.status, {"error": error.message})
        except OSError as error:
            self.log_error("storage error: %s", error)
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "storage error"})

    def _method_not_allowed(self) -> None:
        # An unsupported method may carry a body that this service does not
        # consume, so do not reuse the connection for another request.
        self.close_connection = True
        self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
        self.send_header("Allow", "GET, PUT, DELETE")
        self.send_header("Connection", "close")
        payload = b'{"error":"method not allowed"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="address to listen on")
    parser.add_argument("--port", required=True, type=int, help="port (0 chooses a free port)")
    parser.add_argument("--data", required=True, type=Path, help="JSON persistence file")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        store = Store(args.data)
        server = KVServer((args.host, args.port), store)
    except (OSError, RuntimeError) as error:
        print(f"startup failed: {error}", file=sys.stderr)
        return 1

    shutdown_started = threading.Event()

    def request_shutdown(signum: int, frame: Any) -> None:
        del signum, frame
        if shutdown_started.is_set():
            return
        shutdown_started.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)

    actual_port = server.server_address[1]
    print(f"LISTENING {actual_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
