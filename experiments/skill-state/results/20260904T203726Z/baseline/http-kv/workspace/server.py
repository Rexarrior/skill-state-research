#!/usr/bin/env python3
"""A small persistent HTTP JSON key-value service."""

import argparse
import json
import logging
import math
import os
import signal
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY_BYTES = 1024 * 1024


class Store:
    def __init__(self, data_path: str):
        self.path = Path(data_path)
        self.lock = threading.RLock()
        self.entries: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                entries = json.load(handle)
            if not isinstance(entries, dict):
                raise ValueError("top-level value is not an object")
            self.entries = {
                key: entry for key, entry in entries.items()
                if isinstance(key, str) and isinstance(entry, dict) and "value" in entry
            }
            with self.lock:
                if self._purge_expired_locked():
                    self._save_locked()
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            logging.error("Could not load state from %s: %s", self.path, exc)
            self.entries = {}

    def _purge_expired_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items()
                   if entry.get("expires_at") is not None and entry["expires_at"] <= now]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _save_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_path = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent, text=True
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(self.entries, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.path)
        except Exception:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass
            raise

    def put(self, key: str, value, ttl_seconds: float | None) -> bool:
        with self.lock:
            self._purge_expired_locked()
            existed = key in self.entries
            self.entries[key] = {
                "value": value,
                "expires_at": time.time() + ttl_seconds if ttl_seconds is not None else None,
            }
            self._save_locked()
            return existed

    def get(self, key: str) -> tuple[bool, object | None]:
        with self.lock:
            changed = self._purge_expired_locked()
            if changed:
                self._save_locked()
            entry = self.entries.get(key)
            return (entry is not None, None if entry is None else entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            self._purge_expired_locked()
            if key not in self.entries:
                return False
            del self.entries[key]
            self._save_locked()
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_expired_locked():
                self._save_locked()
            return sorted(self.entries)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "http-kv"

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined]

    def log_message(self, format: str, *args) -> None:
        logging.info("%s - %s", self.address_string(), format % args)

    def _respond(self, status: int, payload=None) -> None:
        self.send_response(status)
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
        else:
            body = b""
            self.send_header("Content-Length", "0")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._respond(status, {"error": message})

    def _key(self):
        path = urlsplit(self.path).path
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None
        encoded_key = path[len(prefix):]
        if not encoded_key or "/" in encoded_key:
            return None
        try:
            key = unquote_to_bytes(encoded_key).decode("utf-8")
        except UnicodeDecodeError:
            return None
        if not key or "/" in key:
            return None
        return key

    def _read_json(self):
        length_header = self.headers.get("Content-Length")
        try:
            length = int(length_header) if length_header is not None else -1
        except ValueError:
            self._error(400, "invalid Content-Length")
            return None
        if length < 0:
            self._error(411, "Content-Length is required")
            return None
        if length > MAX_BODY_BYTES:
            self._error(413, "request body exceeds 1 MiB")
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "malformed JSON")
            return None

    def do_PUT(self) -> None:
        key = self._key()
        if key is None:
            self._error(400, "invalid key or route")
            return
        request = self._read_json()
        if request is None:
            return
        if not isinstance(request, dict) or "value" not in request or set(request) - {"value", "ttl_seconds"}:
            self._error(400, "body must be an object containing value and optional ttl_seconds")
            return
        ttl = request.get("ttl_seconds")
        if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float))
                                or not math.isfinite(ttl) or ttl <= 0):
            self._error(400, "ttl_seconds must be a finite number greater than zero")
            return
        try:
            existed = self.store.put(key, request["value"], ttl)
        except OSError as exc:
            logging.error("Could not persist state: %s", exc)
            self._error(500, "could not persist state")
            return
        self._respond(200 if existed else 201, {"key": key, "value": request["value"]})

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            self._respond(200, {"status": "ok"})
            return
        if path == "/v1/keys":
            try:
                self._respond(200, {"keys": self.store.keys()})
            except OSError as exc:
                logging.error("Could not persist state: %s", exc)
                self._error(500, "could not persist state")
            return
        key = self._key()
        if key is None:
            self._error(404, "route not found")
            return
        try:
            found, value = self.store.get(key)
        except OSError as exc:
            logging.error("Could not persist state: %s", exc)
            self._error(500, "could not persist state")
            return
        if not found:
            self._error(404, "key not found")
            return
        self._respond(200, {"key": key, "value": value})

    def do_DELETE(self) -> None:
        key = self._key()
        if key is None:
            self._error(400, "invalid key or route")
            return
        try:
            deleted = self.store.delete(key)
        except OSError as exc:
            logging.error("Could not persist state: %s", exc)
            self._error(500, "could not persist state")
            return
        if not deleted:
            self._error(404, "key not found")
            return
        self._respond(204)

    def do_POST(self) -> None:
        self._error(405, "method not allowed")

    def do_PATCH(self) -> None:
        self._error(405, "method not allowed")

    def do_HEAD(self) -> None:
        self._error(405, "method not allowed")


def main() -> None:
    parser = argparse.ArgumentParser(description="Persistent HTTP key-value service")
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.store = Store(args.data)  # type: ignore[attr-defined]
    print(f"LISTENING {server.server_address[1]}", flush=True)

    thread = threading.Thread(target=server.serve_forever, name="http-server")
    thread.start()

    def stop(signum, frame) -> None:
        logging.info("Received signal %s; shutting down", signum)
        server.shutdown()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    thread.join()
    server.server_close()


if __name__ == "__main__":
    main()
