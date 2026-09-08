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
from urllib.parse import unquote, urlsplit


MAX_BODY = 1024 * 1024


class Store:
    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        self.lock = threading.RLock()
        self.entries: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as source:
                document = json.load(source, parse_constant=self._bad_constant)
        except FileNotFoundError:
            return
        except (OSError, ValueError, TypeError) as exc:
            raise RuntimeError(f"cannot load data file {self.path}: {exc}") from exc

        if not isinstance(document, dict) or not isinstance(document.get("entries"), dict):
            raise RuntimeError(f"invalid data file {self.path}")
        loaded: dict[str, dict] = {}
        removed = False
        now = time.time()
        for key, item in document["entries"].items():
            if not isinstance(key, str) or not isinstance(item, dict):
                raise RuntimeError(f"invalid data file {self.path}")
            if set(item) != {"value", "expires_at"}:
                raise RuntimeError(f"invalid data file {self.path}")
            expires = item["expires_at"]
            if expires is not None and (
                isinstance(expires, bool)
                or not isinstance(expires, (int, float))
                or not math.isfinite(expires)
            ):
                raise RuntimeError(f"invalid data file {self.path}")
            if expires is not None and expires <= now:
                removed = True
            else:
                loaded[key] = item
        self.entries = loaded
        if removed:
            self._persist()

    @staticmethod
    def _bad_constant(value: str):
        raise ValueError(f"non-finite JSON number {value}")

    def purge_expired(self) -> bool:
        now = time.time()
        expired = [
            key for key, item in self.entries.items()
            if item["expires_at"] is not None and item["expires_at"] <= now
        ]
        for key in expired:
            del self.entries[key]
        if expired:
            self._persist()
        return bool(expired)

    def _persist(self) -> None:
        parent = os.path.dirname(self.path) or "."
        os.makedirs(parent, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".kv-", suffix=".tmp", dir=parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as target:
                json.dump(
                    {"entries": self.entries}, target, ensure_ascii=False,
                    separators=(",", ":"), allow_nan=False,
                )
                target.write("\n")
                target.flush()
                os.fsync(target.fileno())
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
            except FileNotFoundError:
                pass
            raise


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, store: Store):
        super().__init__(address, handler)
        self.store = store


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (
            self.address_string(), self.log_date_time_string(), format % args
        ))

    def __getattr__(self, name: str):
        if name.startswith("do_"):
            return self._method_not_allowed
        raise AttributeError(name)

    def handle_expect_100(self) -> bool:
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) == 1:
            try:
                if int(lengths[0]) > MAX_BODY:
                    self._json_error(413, "request body exceeds 1 MiB")
                    return False
            except ValueError:
                pass
        return super().handle_expect_100()

    def send_error(self, code, message=None, explain=None) -> None:
        self._json_error(code, message or self.responses.get(code, ("Error",))[0])

    def _send_json(self, status: int, payload, *, include_body: bool = True) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body) if include_body else 0))
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def _json_error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _route(self):
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
        if not encoded or "/" in encoded or self._bad_percent_encoding(encoded):
            return "bad_key", None
        try:
            key = unquote(encoded, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return "bad_key", None
        if not key or "/" in key:
            return "bad_key", None
        return "item", key

    @staticmethod
    def _bad_percent_encoding(value: str) -> bool:
        index = 0
        hexdigits = "0123456789abcdefABCDEF"
        while index < len(value):
            if value[index] == "%":
                if index + 2 >= len(value) or value[index + 1] not in hexdigits or value[index + 2] not in hexdigits:
                    return True
                index += 3
            else:
                index += 1
        return False

    def _read_json(self):
        if self.headers.get("Transfer-Encoding") is not None:
            self._json_error(400, "transfer encoding is not supported")
            return None
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1:
            self._json_error(400, "exactly one Content-Length header is required")
            return None
        try:
            length = int(lengths[0])
        except ValueError:
            self._json_error(400, "invalid Content-Length")
            return None
        if length < 0:
            self._json_error(400, "invalid Content-Length")
            return None
        if length > MAX_BODY:
            self._json_error(413, "request body exceeds 1 MiB")
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"), parse_constant=Store._bad_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._json_error(400, "malformed JSON")
            return None

    def _clean_store(self) -> bool:
        try:
            self.server.store.purge_expired()
            return True
        except OSError as exc:
            self.log_error("persistence failure: %s", exc)
            self._json_error(500, "persistence failure")
            return False

    def do_GET(self) -> None:
        route, key = self._route()
        if route == "health":
            self._send_json(200, {"status": "ok"})
            return
        if route == "bad_key":
            self._json_error(400, "invalid key")
            return
        if route == "unknown":
            self._json_error(404, "unknown route")
            return
        with self.server.store.lock:
            if not self._clean_store():
                return
            if route == "keys":
                self._send_json(200, {"keys": sorted(self.server.store.entries)})
                return
            item = self.server.store.entries.get(key)
            if item is None:
                self._json_error(404, "key not found")
            else:
                self._send_json(200, {"key": key, "value": item["value"]})

    def do_PUT(self) -> None:
        route, key = self._route()
        if route == "bad_key":
            self._json_error(400, "invalid key")
            return
        if route != "item":
            self._json_error(404, "unknown route")
            return
        document = self._read_json()
        if document is None:
            return
        if not isinstance(document, dict) or "value" not in document or not set(document) <= {"value", "ttl_seconds"}:
            self._json_error(400, "body must contain value and optional ttl_seconds")
            return
        ttl = document.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool)
            or not isinstance(ttl, (int, float))
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            self._json_error(400, "ttl_seconds must be a finite number greater than zero")
            return
        expires = None if ttl is None else time.time() + ttl
        if expires is not None and not math.isfinite(expires):
            self._json_error(400, "ttl_seconds is too large")
            return
        store = self.server.store
        with store.lock:
            if not self._clean_store():
                return
            existed = key in store.entries
            old = store.entries.get(key)
            store.entries[key] = {"value": document["value"], "expires_at": expires}
            try:
                store._persist()
            except (OSError, ValueError) as exc:
                if existed:
                    store.entries[key] = old
                else:
                    del store.entries[key]
                self.log_error("persistence failure: %s", exc)
                self._json_error(500, "persistence failure")
                return
        self._send_json(200 if existed else 201, {"key": key, "value": document["value"]})

    def do_DELETE(self) -> None:
        route, key = self._route()
        if route == "bad_key":
            self._json_error(400, "invalid key")
            return
        if route != "item":
            self._json_error(404, "unknown route")
            return
        store = self.server.store
        with store.lock:
            if not self._clean_store():
                return
            if key not in store.entries:
                self._json_error(404, "key not found")
                return
            old = store.entries.pop(key)
            try:
                store._persist()
            except (OSError, ValueError) as exc:
                store.entries[key] = old
                self.log_error("persistence failure: %s", exc)
                self._json_error(500, "persistence failure")
                return
        self._send_json(204, {}, include_body=False)

    def _method_not_allowed(self) -> None:
        self._json_error(405, "method not allowed")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler, store)
    except (OSError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    def stop(_signum, _frame):
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
