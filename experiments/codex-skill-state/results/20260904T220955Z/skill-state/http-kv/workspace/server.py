#!/usr/bin/env python3
"""A small persistent JSON key-value HTTP service."""

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
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024


class Store:
    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, object]] = {}
        self._load()

    def _load(self) -> None:
        try:
            with self.path.open("r", encoding="utf-8") as source:
                raw = json.load(source)
            if not isinstance(raw, dict):
                raise ValueError("top-level JSON value is not an object")
            now = time.time()
            discarded = False
            for key, entry in raw.items():
                if (isinstance(key, str) and isinstance(entry, dict)
                        and "value" in entry):
                    expires_at = entry.get("expires_at")
                    if (expires_at is None or (isinstance(expires_at, (int, float))
                                               and not isinstance(expires_at, bool)
                                               and math.isfinite(expires_at)
                                               and expires_at > now)):
                        self.entries[key] = {"value": entry["value"], "expires_at": expires_at}
                    else:
                        discarded = True
                else:
                    discarded = True
            if discarded or self._purge():
                self._save()
        except FileNotFoundError:
            return
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"warning: could not load data file: {exc}", file=sys.stderr, flush=True)

    def _purge(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items()
                   if entry["expires_at"] is not None and entry["expires_at"] <= now]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent, text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as target:
                json.dump(self.entries, target, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temp_name, self.path)
        except BaseException:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
            raise

    def _purge_and_save(self) -> None:
        if self._purge():
            self._save()

    def get(self, key: str) -> tuple[bool, object | None]:
        with self.lock:
            self._purge_and_save()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def put(self, key: str, value: object, ttl: float | None) -> bool:
        with self.lock:
            self._purge_and_save()
            existed = key in self.entries
            self.entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
            self._save()
            return existed

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_and_save()
            if key not in self.entries:
                return False
            del self.entries[key]
            self._save()
            return True

    def keys(self) -> list[str]:
        with self.lock:
            self._purge_and_save()
            return sorted(self.entries)


def decode_key(encoded: str) -> str:
    try:
        key = unquote_to_bytes(encoded).decode("utf-8", "strict")
    except UnicodeDecodeError as exc:
        raise ValueError("key must be UTF-8") from exc
    if not key or "/" in key:
        raise ValueError("key must be non-empty and must not contain '/'")
    return key


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    store: Store

    def log_message(self, format: str, *args: object) -> None:
        print("%s - %s" % (self.address_string(), format % args), file=sys.stderr, flush=True)

    def _json(self, status: int, value: object | None = None) -> None:
        payload = b"" if status == 204 else json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        self.send_response(status)
        if status != 204:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        """Keep BaseHTTPRequestHandler's fallback errors in the JSON API format."""
        self._error(code, message or self.responses.get(code, ("error",))[0])

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _key_route(self) -> str | None:
        path = self._path()
        prefix = "/v1/kv/"
        return path[len(prefix):] if path.startswith(prefix) else None

    def _body(self):
        length = self.headers.get("Content-Length")
        if length is None:
            raise ValueError("Content-Length is required")
        try:
            size = int(length)
        except ValueError as exc:
            raise ValueError("invalid Content-Length") from exc
        if size < 0 or size > MAX_BODY:
            raise OverflowError("request body exceeds 1 MiB")
        try:
            value = json.loads(self.rfile.read(size).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("malformed JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("JSON body must be an object")
        return value

    def do_GET(self) -> None:
        if self._path() == "/health":
            self._json(200, {"status": "ok"})
        elif self._path() == "/v1/keys":
            self._json(200, {"keys": self.store.keys()})
        elif (encoded := self._key_route()) is not None:
            try:
                key = decode_key(encoded)
            except ValueError as exc:
                self._error(400, str(exc)); return
            found, value = self.store.get(key)
            if not found:
                self._error(404, "key not found")
            else:
                self._json(200, {"key": key, "value": value})
        else:
            self._error(404, "route not found")

    def do_PUT(self) -> None:
        encoded = self._key_route()
        if encoded is None:
            self._error(404, "route not found"); return
        try:
            key = decode_key(encoded)
            body = self._body()
            if "value" not in body or set(body) - {"value", "ttl_seconds"}:
                raise ValueError("body must contain value and optional ttl_seconds only")
            ttl = body.get("ttl_seconds")
            if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float))
                                    or not math.isfinite(ttl) or ttl <= 0):
                raise ValueError("ttl_seconds must be a finite number greater than zero")
            replaced = self.store.put(key, body["value"], ttl)
            self._json(200 if replaced else 201, {"key": key, "value": body["value"]})
        except OverflowError as exc:
            self._error(413, str(exc))
        except ValueError as exc:
            self._error(400, str(exc))
        except OSError as exc:
            print(f"persistence error: {exc}", file=sys.stderr, flush=True)
            self._error(500, "persistence failed")

    def do_DELETE(self) -> None:
        encoded = self._key_route()
        if encoded is None:
            self._error(404, "route not found"); return
        try:
            key = decode_key(encoded)
        except ValueError as exc:
            self._error(400, str(exc)); return
        deleted = self.store.delete(key)
        self._json(204 if deleted else 404, None if deleted else {"error": "key not found"})

    def do_POST(self) -> None: self._error(405, "method not allowed")
    def do_PATCH(self) -> None: self._error(405, "method not allowed")
    def do_HEAD(self) -> None: self._error(405, "method not allowed")


def serve(host: str, port: int, data: str) -> None:
    Handler.store = Store(data)
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    print(f"LISTENING {server.server_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


class SelfTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name) / "data.json"
        self.store = Store(str(self.data))

    def tearDown(self):
        self.tmp.cleanup()

    def test_crud_ttl_and_persistence(self):
        self.assertFalse(self.store.put("a b", [1], .05))
        self.assertEqual(self.store.get("a b"), (True, [1]))
        self.assertTrue(self.data.exists())
        time.sleep(.08)
        self.assertEqual(self.store.get("a b"), (False, None))
        self.assertFalse(self.store.put("z", None, None))
        self.assertEqual(self.store.keys(), ["z"])
        reloaded = Store(str(self.data))
        self.assertEqual(reloaded.get("z"), (True, None))
        self.assertTrue(reloaded.delete("z"))
        self.assertFalse(reloaded.delete("z"))

    def test_validation(self):
        self.assertEqual(decode_key("a%20b"), "a b")
        for encoded in ("", "a/b", "%FF"):
            with self.assertRaises(ValueError):
                decode_key(encoded)
        with self.assertRaises(ValueError):
            json.loads("[")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--data")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        unittest.main(argv=[sys.argv[0]])
    else:
        if args.host is None or args.port is None or args.data is None:
            parser.error("--host, --port, and --data are required unless --self-test is used")
        serve(args.host, args.port, args.data)


if __name__ == "__main__":
    main()
