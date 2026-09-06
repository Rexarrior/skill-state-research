#!/usr/bin/env python3
"""A small persistent JSON HTTP key-value service."""

from __future__ import annotations

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
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


MAX_BODY = 1024 * 1024


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        try:
            with self.path.open("r", encoding="utf-8") as source:
                loaded = json.load(source)
            if not isinstance(loaded, dict):
                raise ValueError("top-level JSON must be an object")
            now = time.time()
            for key, entry in loaded.items():
                if (isinstance(key, str) and isinstance(entry, dict)
                        and "value" in entry):
                    expires = entry.get("expires_at")
                    if expires is None or (isinstance(expires, (int, float))
                                           and not isinstance(expires, bool)
                                           and math.isfinite(expires) and expires > now):
                        self.entries[key] = {"value": entry["value"], "expires_at": expires}
            self._purge_and_save_if_needed()
        except FileNotFoundError:
            return
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            logging.error("could not load data file %s: %s", self.path, exc)

    def _purge_locked(self) -> bool:
        now = time.time()
        expired = [key for key, entry in self.entries.items()
                   if entry["expires_at"] is not None and entry["expires_at"] <= now]
        for key in expired:
            del self.entries[key]
        return bool(expired)

    def _save_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as target:
                json.dump(self.entries, target, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, self.path)
        except Exception:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def _purge_and_save_if_needed(self) -> None:
        with self.lock:
            if self._purge_locked():
                self._save_locked()

    def put(self, key: str, value: Any, ttl: float | None) -> bool:
        with self.lock:
            self._purge_locked()
            created = key not in self.entries
            self.entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
            self._save_locked()
            return created

    def get(self, key: str) -> tuple[bool, Any | None]:
        with self.lock:
            changed = self._purge_locked()
            entry = self.entries.get(key)
            if changed:
                self._save_locked()
            return (entry is not None, None if entry is None else entry["value"])

    def delete(self, key: str) -> bool:
        with self.lock:
            changed = self._purge_locked()
            if key not in self.entries:
                if changed:
                    self._save_locked()
                return False
            del self.entries[key]
            self._save_locked()
            return True

    def keys(self) -> list[str]:
        with self.lock:
            if self._purge_locked():
                self._save_locked()
            return sorted(self.entries)

    def save(self) -> None:
        with self.lock:
            self._purge_locked()
            self._save_locked()


def make_handler(store: Store) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "PersistentKV/1.0"

        def log_message(self, format: str, *args: Any) -> None:
            logging.info("%s - %s", self.address_string(), format % args)

        def _respond(self, status: int, payload: Any | None = None) -> None:
            self.send_response(status)
            if payload is not None:
                encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
            else:
                encoded = b""
                self.send_header("Content-Length", "0")
            self.end_headers()
            if encoded:
                self.wfile.write(encoded)

        def _error(self, status: int, message: str) -> None:
            self._respond(status, {"error": message})

        def _key(self) -> str | None:
            raw_path = urlsplit(self.path).path
            prefix = "/v1/kv/"
            if not raw_path.startswith(prefix):
                return None
            raw_key = raw_path[len(prefix):]
            if not raw_key or "/" in raw_key:
                return None
            try:
                key = unquote_to_bytes(raw_key).decode("utf-8")
            except UnicodeDecodeError:
                return None
            return key if key and "/" not in key else None

        def _read_json(self) -> Any:
            length_header = self.headers.get("Content-Length")
            if length_header is None:
                raise ValueError("Content-Length is required")
            try:
                length = int(length_header)
            except ValueError as exc:
                raise ValueError("invalid Content-Length") from exc
            if length < 0 or length > MAX_BODY:
                raise OverflowError("request body exceeds 1 MiB")
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError("malformed JSON") from exc

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == "/health":
                self._respond(200, {"status": "ok"})
            elif path == "/v1/keys":
                self._respond(200, {"keys": store.keys()})
            else:
                key = self._key()
                if key is None:
                    self._error(404, "unknown route")
                    return
                found, value = store.get(key)
                if not found:
                    self._error(404, "key not found")
                else:
                    self._respond(200, {"key": key, "value": value})

        def do_PUT(self) -> None:
            key = self._key()
            if key is None:
                self._error(404, "unknown route")
                return
            try:
                body = self._read_json()
                if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                    raise ValueError("body must be an object with value and optional ttl_seconds")
                ttl = body.get("ttl_seconds")
                if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float))
                                        or not math.isfinite(ttl) or ttl <= 0):
                    raise ValueError("ttl_seconds must be a finite number greater than zero")
                json.dumps(body["value"], allow_nan=False)
            except OverflowError as exc:
                self._error(413, str(exc))
                return
            except (TypeError, ValueError) as exc:
                self._error(400, str(exc))
                return
            try:
                created = store.put(key, body["value"], ttl)
            except (OSError, TypeError, ValueError) as exc:
                logging.exception("failed to persist update")
                self._error(500, "could not persist data")
                return
            self._respond(201 if created else 200, {"key": key, "value": body["value"]})

        def do_DELETE(self) -> None:
            key = self._key()
            if key is None:
                self._error(404, "unknown route")
            elif store.delete(key):
                self._respond(204)
            else:
                self._error(404, "key not found")

        def do_POST(self) -> None: self._error(405, "method not allowed")
        def do_PATCH(self) -> None: self._error(405, "method not allowed")
        def do_HEAD(self) -> None: self._error(405, "method not allowed")

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True, type=Path)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    store = Store(args.data)
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(store))
    httpd.daemon_threads = True

    def stop(_signum: int, _frame: Any) -> None:
        logging.info("SIGTERM received; shutting down")
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    print(f"LISTENING {httpd.server_address[1]}", flush=True)
    try:
        httpd.serve_forever()
    finally:
        store.save()
        httpd.server_close()


if __name__ == "__main__":
    main()
