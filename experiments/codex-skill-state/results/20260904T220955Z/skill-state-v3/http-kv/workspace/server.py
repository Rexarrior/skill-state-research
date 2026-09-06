#!/usr/bin/env python3
"""A small persistent HTTP JSON key-value service."""

import argparse
import json
import logging
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
    def __init__(self, data_path):
        self.path = Path(data_path)
        self.lock = threading.RLock()
        self.entries = {}
        self._load()

    def _live(self, entry, now=None):
        expires = entry.get("expires_at")
        return expires is None or expires > (time.time() if now is None else now)

    def _purge_locked(self):
        expired = [key for key, entry in self.entries.items() if not self._live(entry)]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _load(self):
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as stream:
                payload = json.load(stream)
            if not isinstance(payload, dict) or not isinstance(payload.get("entries", {}), dict):
                raise ValueError("invalid persistence shape")
            for key, entry in payload["entries"].items():
                if (isinstance(key, str) and isinstance(entry, dict)
                        and "value" in entry and entry.get("expires_at") is not None
                        and not isinstance(entry["expires_at"], (int, float))):
                    continue
                if isinstance(key, str) and isinstance(entry, dict) and "value" in entry:
                    self.entries[key] = {"value": entry["value"], "expires_at": entry.get("expires_at")}
            if self._purge_locked():
                self._persist_locked()
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            logging.error("could not load data file %s: %s", self.path, exc)

    def _persist_locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent, text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump({"entries": self.entries}, stream, ensure_ascii=False, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        except Exception:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def put(self, key, value, ttl):
        with self.lock:
            changed = self._purge_locked()
            existed = key in self.entries
            self.entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
            self._persist_locked()
            return existed

    def get(self, key):
        with self.lock:
            if self._purge_locked():
                self._persist_locked()
            entry = self.entries.get(key)
            return (False, None) if entry is None else (True, entry["value"])

    def delete(self, key):
        with self.lock:
            changed = self._purge_locked()
            if key not in self.entries:
                if changed:
                    self._persist_locked()
                return False
            del self.entries[key]
            self._persist_locked()
            return True

    def keys(self):
        with self.lock:
            if self._purge_locked():
                self._persist_locked()
            return sorted(self.entries)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    store = None

    def log_message(self, fmt, *args):
        logging.info("%s - %s", self.address_string(), fmt % args)

    def _respond(self, status, data=None):
        body = b"" if status == 204 else json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        if status != 204:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, status, message):
        self._respond(status, {"error": message})

    def _key(self):
        prefix = "/v1/kv/"
        path = urlsplit(self.path).path
        if not path.startswith(prefix):
            return None
        encoded = path[len(prefix):]
        if not encoded or "/" in encoded:
            return None
        try:
            key = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeDecodeError:
            return None
        return key if key and "/" not in key else None

    def _read_json(self):
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length) if raw_length is not None else -1
        except ValueError:
            self._error(400, "invalid Content-Length")
            return None
        if length < 0:
            self._error(411, "Content-Length required")
            return None
        if length > MAX_BODY:
            self._error(413, "request body too large")
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "malformed JSON")
            return None

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            return self._respond(200, {"status": "ok"})
        if path == "/v1/keys":
            return self._respond(200, {"keys": self.store.keys()})
        key = self._key()
        if key is None:
            return self._error(404, "unknown route")
        found, value = self.store.get(key)
        if not found:
            return self._error(404, "key not found")
        self._respond(200, {"key": key, "value": value})

    def do_PUT(self):
        key = self._key()
        if key is None:
            return self._error(404, "unknown route")
        payload = self._read_json()
        if payload is None:
            return
        if not isinstance(payload, dict) or "value" not in payload or set(payload) - {"value", "ttl_seconds"}:
            return self._error(400, "body must contain value and optional ttl_seconds")
        ttl = payload.get("ttl_seconds")
        if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0):
            return self._error(400, "ttl_seconds must be a finite number greater than zero")
        try:
            existed = self.store.put(key, payload["value"], ttl)
        except OSError as exc:
            logging.error("persistence failure: %s", exc)
            return self._error(500, "persistence failure")
        self._respond(200 if existed else 201, {"key": key, "value": payload["value"]})

    def do_DELETE(self):
        key = self._key()
        if key is None:
            return self._error(404, "unknown route")
        try:
            deleted = self.store.delete(key)
        except OSError as exc:
            logging.error("persistence failure: %s", exc)
            return self._error(500, "persistence failure")
        if not deleted:
            return self._error(404, "key not found")
        self._respond(204)

    def do_POST(self): self._error(405, "method not allowed")
    def do_PATCH(self): self._error(405, "method not allowed")
    def do_HEAD(self): self._error(405, "method not allowed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    Handler.store = Store(args.data)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    def stop(signum, frame):
        logging.info("received signal %s; shutting down", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    print(f"LISTENING {server.server_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
