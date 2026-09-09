#!/usr/bin/env python3
"""A small, persistent HTTP key-value service using only the standard library."""

import argparse
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote_to_bytes, urlsplit

MAX_BODY = 1024 * 1024


def reject_constant(value):
    raise ValueError(f"Invalid JSON number: {value}")


def finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("JSON numbers must be finite")
    return result


def decode_json(raw):
    return json.loads(raw.decode("utf-8"), parse_constant=reject_constant,
                      parse_float=finite_float)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            saved = decode_json(self.path.read_bytes())
            if not isinstance(saved, dict) or saved.get("version") != 1 or not isinstance(saved.get("entries"), dict):
                raise ValueError("Invalid state file")
            now = time.time()
            for key, entry in saved["entries"].items():
                if not key or "/" in key or not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("Invalid state entry")
                key.encode("utf-8")
                expiry = entry["expires_at"]
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError("Invalid stored expiration")
                if expiry is None or expiry > now:
                    self.entries[key] = entry

    def live(self):
        now = time.time()
        return {k: v for k, v in self.entries.items()
                if v["expires_at"] is None or v["expires_at"] > now}

    def persist(self, entries):
        # Commit disk first: a failed write must not change in-memory state.
        payload = json.dumps({"version": 1, "entries": entries},
                             ensure_ascii=True, allow_nan=False).encode("utf-8")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=".kv-", delete=False) as file:
                name = file.name
                file.write(payload)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
            name = None
        finally:
            if name is not None:
                os.unlink(name)
        self.entries = entries

    def put(self, key, value, ttl):
        with self.lock:
            entries = self.live()
            created = key not in entries
            entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
            self.persist(entries)
            return created

    def get(self, key):
        with self.lock:
            self.entries = self.live()
            return self.entries.get(key)

    def delete(self, key):
        with self.lock:
            entries = self.live()
            if key not in entries:
                return False
            del entries[key]
            self.persist(entries)
            return True

    def keys(self):
        with self.lock:
            self.entries = self.live()
            return sorted(self.entries)


class APIError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def reply(self, status, body=None):
        raw = b"" if body is None else json.dumps(body, ensure_ascii=True, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def send_error(self, code, message=None, explain=None):
        self.close_connection = True
        if code == 501:
            code = 405
            message = "Unsupported method"
        self.reply(code, {"error": message or self.responses.get(code, ("Request error",))[0]})
        if code == 413:
            # Let an uploading client receive the error before closing its socket.
            # Bound draining so an oversized or stalled upload cannot hold a worker.
            try:
                self.connection.shutdown(socket.SHUT_WR)
                self.connection.settimeout(0.2)
                remaining = MAX_BODY * 2
                deadline = time.monotonic() + 0.5
                while remaining > 0 and time.monotonic() < deadline:
                    chunk = self.connection.recv(min(65536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
            except OSError:
                pass

    def route(self):
        try:
            path = urlsplit(self.path).path
        except ValueError:
            raise APIError(400, "Invalid URL")
        if path in ("/health", "/v1/keys"):
            return path, None
        if not path.startswith("/v1/kv/"):
            raise APIError(404, "Unknown route")
        encoded = path[len("/v1/kv/"):]
        if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
            raise APIError(400, "Invalid key encoding")
        try:
            key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        except (UnicodeError, ValueError):
            raise APIError(400, "Key must be UTF-8")
        if not key or "/" in key:
            raise APIError(400, "Key must be nonempty and cannot contain '/' ")
        return "/v1/kv/", key

    def body_length(self):
        if self.headers.get_all("Transfer-Encoding"):
            raise APIError(400, "Transfer-Encoding is unsupported; use Content-Length")
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths:
            return None
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
            raise APIError(400, "Invalid Content-Length")
        if len(lengths[0]) > 16 or int(lengths[0]) > MAX_BODY:
            raise APIError(413, "Request body exceeds 1 MiB")
        return int(lengths[0])

    def body(self):
        length = self.body_length()
        if length is None:
            raise APIError(411, "Content-Length is required")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise APIError(400, "Incomplete request body")
        try:
            obj = decode_json(raw)
        except (ValueError, UnicodeError, RecursionError):
            raise APIError(400, "Malformed JSON")
        if not isinstance(obj, dict) or "value" not in obj or set(obj) - {"value", "ttl_seconds"}:
            raise APIError(400, "Expected value and optional ttl_seconds")
        ttl = obj.get("ttl_seconds")
        if "ttl_seconds" in obj:
            try:
                valid = type(ttl) in (int, float) and math.isfinite(ttl) and ttl > 0 and math.isfinite(time.time() + ttl)
            except OverflowError:
                valid = False
            if not valid:
                raise APIError(400, "ttl_seconds must be finite and greater than zero")
        return obj["value"], ttl

    def dispatch(self):
        try:
            self.body_length()
            route, key = self.route()
            store = self.server.store
            if route == "/health" and self.command == "GET":
                self.reply(200, {"status": "ok"})
            elif route == "/v1/keys" and self.command == "GET":
                self.reply(200, {"keys": store.keys()})
            elif route != "/v1/kv/":
                raise APIError(405, "Unsupported method")
            elif self.command == "PUT":
                value, ttl = self.body()
                created = store.put(key, value, ttl)
                self.reply(201 if created else 200, {"key": key, "value": value})
            elif self.command == "GET":
                entry = store.get(key)
                if entry is None:
                    raise APIError(404, "Key not found")
                self.reply(200, {"key": key, "value": entry["value"]})
            elif self.command == "DELETE":
                if not store.delete(key):
                    raise APIError(404, "Key not found")
                self.reply(204)
            else:
                raise APIError(405, "Unsupported method")
        except APIError as error:
            self.send_error(error.status, error.message)
        except TimeoutError:
            self.send_error(408, "Request timed out")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            print(f"Request failed: {error}", file=sys.stderr, flush=True)
            self.send_error(500, "Internal server error")

    do_GET = do_PUT = do_DELETE = do_POST = do_PATCH = do_HEAD = do_OPTIONS = dispatch


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    try:
        store = Store(args.data)
        with Server((args.host, args.port), Handler) as server:
            server.store = store
            server.timeout = 0.2
            print(f"LISTENING {server.server_port}", flush=True)
            while not stopped.is_set():
                server.handle_request()
    except (OSError, ValueError) as error:
        print(f"Startup failed: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
