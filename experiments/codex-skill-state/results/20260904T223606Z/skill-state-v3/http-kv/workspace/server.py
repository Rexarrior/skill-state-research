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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024


class Store:
    def __init__(self, filename: str):
        self.path = Path(filename)
        self.lock = threading.RLock()
        self.entries = {}
        self._load()

    @staticmethod
    def _live(entry, now):
        expiry = entry.get("expires_at")
        return expiry is None or expiry > now

    def _load(self):
        with self.lock:
            if not self.path.exists():
                return
            try:
                with self.path.open("r", encoding="utf-8") as handle:
                    payload = json.load(handle)
                if not isinstance(payload, dict):
                    raise ValueError("top-level JSON is not an object")
                now = time.time()
                changed = False
                for key, entry in payload.items():
                    if (isinstance(key, str) and isinstance(entry, dict)
                            and "value" in entry
                            and (entry.get("expires_at") is None
                                 or isinstance(entry.get("expires_at"), (int, float)))):
                        if self._live(entry, now):
                            self.entries[key] = entry
                        else:
                            changed = True
                    else:
                        changed = True
                if changed:
                    self._persist()
            except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
                print(f"warning: unable to load data file: {exc}", file=sys.stderr, flush=True)

    def _purge(self):
        now = time.time()
        expired = [key for key, entry in self.entries.items() if not self._live(entry, now)]
        if expired:
            for key in expired:
                del self.entries[key]
            self._persist()

    def _persist(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".kv-", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(self.entries, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except Exception:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def get(self, key):
        with self.lock:
            self._purge()
            entry = self.entries.get(key)
            return None if entry is None else entry["value"]

    def put(self, key, value, ttl):
        with self.lock:
            self._purge()
            created = key not in self.entries
            self.entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
            self._persist()
            return created

    def delete(self, key):
        with self.lock:
            self._purge()
            if key not in self.entries:
                return False
            del self.entries[key]
            self._persist()
            return True

    def keys(self):
        with self.lock:
            self._purge()
            return sorted(self.entries)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    store = None

    def log_message(self, fmt, *args):
        print(f"{self.client_address[0]} - {fmt % args}", file=sys.stderr, flush=True)

    def _json(self, status, body=None):
        encoded = b"" if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)

    def _error(self, status, message):
        self._json(status, {"error": message})

    def _key(self):
        path = urlsplit(self.path).path
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        raw = path[len(prefix):]
        if not raw or "/" in raw:
            raise ValueError("invalid key")
        try:
            key = unquote_to_bytes(raw).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("key must be UTF-8") from exc
        if not key or "/" in key:
            raise ValueError("invalid key")
        return key

    def _body(self):
        length = self.headers.get("Content-Length")
        if length is None:
            raise ValueError("Content-Length is required")
        try:
            length = int(length)
        except ValueError as exc:
            raise ValueError("invalid Content-Length") from exc
        if length < 0 or length > MAX_BODY:
            raise OverflowError("request body exceeds 1 MiB")
        try:
            parsed = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("malformed JSON") from exc
        if not isinstance(parsed, dict) or set(parsed) - {"value", "ttl_seconds"} or "value" not in parsed:
            raise ValueError("body must be an object with value and optional ttl_seconds")
        ttl = parsed.get("ttl_seconds")
        if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float))
                                or not math.isfinite(ttl) or ttl <= 0):
            raise ValueError("ttl_seconds must be a finite number greater than zero")
        return parsed["value"], ttl

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            return self._json(200, {"status": "ok"})
        if path == "/v1/keys":
            return self._json(200, {"keys": self.store.keys()})
        try:
            key = self._key()
        except ValueError as exc:
            return self._error(400, str(exc))
        if key is None:
            return self._error(404, "not found")
        value = self.store.get(key)
        if value is None and key not in self.store.entries:
            return self._error(404, "not found")
        return self._json(200, {"key": key, "value": value})

    def do_PUT(self):
        try:
            key = self._key()
            if key is None:
                return self._error(404, "not found")
            value, ttl = self._body()
            created = self.store.put(key, value, ttl)
        except OverflowError as exc:
            return self._error(413, str(exc))
        except ValueError as exc:
            return self._error(400, str(exc))
        except OSError as exc:
            print(f"persistence error: {exc}", file=sys.stderr, flush=True)
            return self._error(500, "persistence failure")
        return self._json(201 if created else 200, {"key": key, "value": value})

    def do_DELETE(self):
        try:
            key = self._key()
        except ValueError as exc:
            return self._error(400, str(exc))
        if key is None:
            return self._error(404, "not found")
        try:
            deleted = self.store.delete(key)
        except OSError as exc:
            print(f"persistence error: {exc}", file=sys.stderr, flush=True)
            return self._error(500, "persistence failure")
        if not deleted:
            return self._error(404, "not found")
        return self._json(204)

    def do_POST(self): self._error(405, "method not allowed")
    def do_PATCH(self): self._error(405, "method not allowed")
    def do_HEAD(self): self._error(405, "method not allowed")


def main():
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    Handler.store = Store(args.data)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True

    def stop(signum, frame):
        print("received shutdown signal", file=sys.stderr, flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    print(f"LISTENING {server.server_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
