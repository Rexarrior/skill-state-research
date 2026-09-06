#!/usr/bin/env python3
"""A small persistent HTTP JSON key-value service."""

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
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024


class APIError(Exception):
    def __init__(self, status, error):
        self.status, self.error = status, error


def decode_key(path):
    try:
        raw = unquote_to_bytes(path)
        key = raw.decode("utf-8")
    except (UnicodeDecodeError, ValueError):
        raise APIError(400, "invalid key encoding")
    if not key or "/" in key:
        raise APIError(400, "invalid key")
    return key


class Store:
    def __init__(self, filename):
        self.filename = Path(filename)
        self.lock = threading.RLock()
        self.entries = {}
        self._load()

    def _load(self):
        try:
            with self.filename.open("r", encoding="utf-8") as source:
                loaded = json.load(source)
            if not isinstance(loaded, dict):
                raise ValueError("root is not an object")
            for key, entry in loaded.items():
                if (isinstance(key, str) and isinstance(entry, dict)
                        and "value" in entry and entry.get("expires_at") is not None
                        or isinstance(key, str) and isinstance(entry, dict) and "value" in entry):
                    expires_at = entry.get("expires_at")
                    if expires_at is None or (isinstance(expires_at, (int, float)) and not isinstance(expires_at, bool)):
                        self.entries[key] = {"value": entry["value"], "expires_at": expires_at}
        except FileNotFoundError:
            return
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"warning: could not load data file: {exc}", file=sys.stderr, flush=True)
            return
        with self.lock:
            if self._purge_locked():
                self._save_locked()

    def _purge_locked(self):
        now = time.time()
        expired = [key for key, entry in self.entries.items()
                   if entry["expires_at"] is not None and entry["expires_at"] <= now]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _save_locked(self):
        self.filename.parent.mkdir(parents=True, exist_ok=True)
        encoded = json.dumps(self.entries, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        descriptor, temporary = tempfile.mkstemp(prefix=".kv-", suffix=".tmp", dir=str(self.filename.parent))
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as target:
                target.write(encoded)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, self.filename)
        except Exception:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def put(self, key, value, ttl):
        with self.lock:
            changed = self._purge_locked()
            existed = key in self.entries
            self.entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
            self._save_locked()
            return existed

    def get(self, key):
        with self.lock:
            if self._purge_locked():
                self._save_locked()
            entry = self.entries.get(key)
            return None if entry is None else entry["value"]

    def delete(self, key):
        with self.lock:
            self._purge_locked()
            if key not in self.entries:
                return False
            del self.entries[key]
            self._save_locked()
            return True

    def keys(self):
        with self.lock:
            if self._purge_locked():
                self._save_locked()
            return sorted(self.entries)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    store = None

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), file=sys.stderr, flush=True)

    def _send(self, status, body=None):
        encoded = b"" if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)

    def _error(self, status, error):
        self._send(status, {"error": error})

    def _key_for_request(self):
        path = urlsplit(self.path).path
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            raise APIError(404, "not found")
        return decode_key(path[len(prefix):])

    def _body(self):
        length = self.headers.get("Content-Length")
        if length is None:
            raise APIError(400, "Content-Length required")
        try:
            length = int(length)
        except ValueError:
            raise APIError(400, "invalid Content-Length")
        if length < 0 or length > MAX_BODY:
            raise APIError(413, "request body too large")
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise APIError(400, "malformed JSON")
        if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
            raise APIError(400, "body must be an object containing value")
        ttl = body.get("ttl_seconds")
        if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0):
            raise APIError(400, "ttl_seconds must be a finite positive number")
        return body["value"], ttl

    def do_GET(self):
        try:
            path = urlsplit(self.path).path
            if path == "/health":
                return self._send(200, {"status": "ok"})
            if path == "/v1/keys":
                return self._send(200, {"keys": self.store.keys()})
            key = self._key_for_request()
            value = self.store.get(key)
            if value is None and key not in self.store.keys():
                raise APIError(404, "not found")
            self._send(200, {"key": key, "value": value})
        except APIError as exc:
            self._error(exc.status, exc.error)
        except OSError as exc:
            self._error(500, "persistence failure")
            print(f"persistence error: {exc}", file=sys.stderr, flush=True)

    def do_PUT(self):
        try:
            key = self._key_for_request()
            value, ttl = self._body()
            existed = self.store.put(key, value, ttl)
            self._send(200 if existed else 201, {"key": key, "value": value})
        except APIError as exc:
            self._error(exc.status, exc.error)
        except (OSError, TypeError, ValueError) as exc:
            self._error(500, "persistence failure")
            print(f"persistence error: {exc}", file=sys.stderr, flush=True)

    def do_DELETE(self):
        try:
            key = self._key_for_request()
            if not self.store.delete(key):
                raise APIError(404, "not found")
            self._send(204)
        except APIError as exc:
            self._error(exc.status, exc.error)
        except OSError as exc:
            self._error(500, "persistence failure")

    def do_POST(self): self._error(405, "method not allowed")
    def do_PATCH(self): self._error(405, "method not allowed")
    def do_HEAD(self): self._error(405, "method not allowed")


def serve(host, port, data):
    Handler.store = Store(data)
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    def stop(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        Handler.store = Store(Path(self.dir.name) / "data.json")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.dir.cleanup()

    def request(self, method, path, body=None):
        conn = HTTPConnection("127.0.0.1", self.server.server_port)
        conn.request(method, path, body=None if body is None else json.dumps(body), headers={"Content-Type": "application/json"})
        response = conn.getresponse(); raw = response.read(); conn.close()
        return response.status, json.loads(raw) if raw else None

    def test_lifecycle_persistence_and_ttl(self):
        self.assertEqual(self.request("PUT", "/v1/kv/hello%20world", {"value": [1]} )[0], 201)
        self.assertEqual(self.request("GET", "/v1/kv/hello%20world"), (200, {"key": "hello world", "value": [1]}))
        self.assertEqual(self.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": .01})[0], 201)
        time.sleep(.03)
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)
        self.assertEqual(self.request("DELETE", "/v1/kv/hello%20world")[0], 204)

    def test_validation(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        self.assertEqual(self.request("PUT", "/v1/kv/x", {"ttl_seconds": 1})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0})[0], 400)
        self.assertEqual(self.request("GET", "/v1/kv/")[0], 400)


def main():
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
