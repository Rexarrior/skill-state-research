#!/usr/bin/env python3
"""A small, persistent, thread-safe HTTP key-value service."""

import argparse
import json
import math
import os
from pathlib import Path
import re
import signal
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


def decode_json(data):
    return json.loads(data, parse_constant=reject_constant, parse_float=finite_float)


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def finite_number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            state = decode_json(self.path.read_text(encoding="utf-8"))
            if not isinstance(state, dict) or state.get("version") != 1:
                raise ValueError("Invalid data file version")
            entries = state.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("Invalid data file entries")
            for key, entry in entries.items():
                if not valid_key(key) or not isinstance(entry, dict):
                    raise ValueError("Invalid stored entry")
                if set(entry) != {"value", "expires_at"}:
                    raise ValueError("Invalid stored entry fields")
                expiry = entry["expires_at"]
                if expiry is not None and not finite_number(expiry):
                    raise ValueError("Invalid stored expiration")
            self.entries = self.live(entries)
            if len(self.entries) != len(entries):
                self.persist(self.entries)
        else:
            self.persist(self.entries)

    @staticmethod
    def live(entries):
        now = time.time()
        return {key: entry for key, entry in entries.items()
                if entry["expires_at"] is None or entry["expires_at"] > now}

    def persist(self, entries):
        # The temporary file is on the same filesystem as the destination.
        payload = json.dumps({"version": 1, "entries": entries},
                             ensure_ascii=True, allow_nan=False).encode("utf-8")
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(mode="wb", dir=self.path.parent,
                                             prefix=f".{self.path.name}.",
                                             suffix=".tmp", delete=False) as file:
                temp_path = file.name
                file.write(payload)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temp_path, self.path)
        finally:
            if temp_path is not None:
                try:
                    os.unlink(temp_path)
                except FileNotFoundError:
                    pass

    def put(self, key, value, ttl):
        with self.lock:
            entries = self.live(self.entries)
            created = key not in entries
            expires_at = None if ttl is None else time.time() + ttl
            if expires_at is not None and not math.isfinite(expires_at):
                raise ValueError("TTL produces an invalid expiration")
            entries[key] = {"value": value, "expires_at": expires_at}
            self.persist(entries)
            self.entries = entries
            return created

    def get(self, key):
        with self.lock:
            return self.live(self.entries)[key]["value"]

    def keys(self):
        with self.lock:
            return sorted(self.live(self.entries))

    def delete(self, key):
        with self.lock:
            entries = self.live(self.entries)
            if key not in entries:
                return False
            del entries[key]
            self.persist(entries)
            self.entries = entries
            return True


class RequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0 closes each connection, including after rejected request bodies.
    server_version = "HTTPKV/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def send_json(self, status, payload=None):
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=True, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        # Also cover errors raised by the standard library's HTTP parser.
        if code == 501:
            code = 405
        self.send_json(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def body_length(self):
        if self.headers.get_all("Transfer-Encoding"):
            raise RequestError(400, "Transfer-Encoding is not supported")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1:
            raise RequestError(400, "Multiple Content-Length headers")
        if not lengths:
            return 0
        raw = lengths[0].strip()
        if not re.fullmatch(r"[0-9]+", raw):
            raise RequestError(400, "Invalid Content-Length")
        # Compare as decimal text before converting arbitrarily large headers.
        raw = raw.lstrip("0") or "0"
        if len(raw) > len(str(MAX_BODY)) or int(raw) > MAX_BODY:
            raise RequestError(413, "Request body exceeds 1 MiB")
        return int(raw)

    def route(self):
        try:
            path = urlsplit(self.path).path
        except ValueError:
            raise RequestError(400, "Invalid request target")
        if path in ("/health", "/v1/keys"):
            return path, None
        if path.startswith("/v1/kv/"):
            raw_key = path[len("/v1/kv/"):]
            if re.search(r"%(?![0-9a-fA-F]{2})", raw_key):
                raise RequestError(400, "Invalid key encoding")
            try:
                key = unquote_to_bytes(raw_key).decode("utf-8", errors="strict")
            except (UnicodeError, ValueError):
                raise RequestError(400, "Key must be UTF-8")
            if not valid_key(key):
                raise RequestError(400, "Key must be nonempty and contain no slash")
            return "/v1/kv/", key
        raise RequestError(404, "Unknown route")

    def handle_request(self):
        try:
            length = self.body_length()
            route, key = self.route()
            allowed = ("GET", "PUT", "DELETE") if key is not None else ("GET",)
            if self.command not in allowed:
                raise RequestError(405, "Method not allowed")
            payload = None
            if length:
                data = self.rfile.read(length)
                if len(data) != length:
                    raise RequestError(400, "Incomplete request body")
                try:
                    payload = decode_json(data.decode("utf-8"))
                except (ValueError, UnicodeError, RecursionError):
                    raise RequestError(400, "Malformed JSON")
            store = self.server.store
            if route == "/health":
                self.send_json(200, {"status": "ok"})
            elif route == "/v1/keys":
                self.send_json(200, {"keys": store.keys()})
            elif self.command == "GET":
                try:
                    value = store.get(key)
                except KeyError:
                    raise RequestError(404, "Key not found")
                self.send_json(200, {"key": key, "value": value})
            elif self.command == "DELETE":
                if not store.delete(key):
                    raise RequestError(404, "Key not found")
                self.send_json(204)
            else:
                if not isinstance(payload, dict) or "value" not in payload:
                    raise RequestError(400, "Body must be an object containing value")
                ttl = payload.get("ttl_seconds")
                if "ttl_seconds" in payload and (not finite_number(ttl) or ttl <= 0):
                    raise RequestError(400, "ttl_seconds must be finite and positive")
                created = store.put(key, payload["value"], ttl)
                self.send_json(201 if created else 200, {"key": key, "value": payload["value"]})
        except RequestError as exc:
            self.send_json(exc.status, {"error": exc.message})
        except TimeoutError:
            self.send_json(408, {"error": "Request body timed out"})
        except (ValueError, RecursionError):
            self.send_json(400, {"error": "Invalid JSON value or TTL"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as exc:
            self.log_error("Storage or connection error: %s", exc)
            self.send_json(500, {"error": "Unable to complete request"})

    do_GET = handle_request
    do_PUT = handle_request
    do_DELETE = handle_request

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.handle_request
        raise AttributeError(name)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
    except (OSError, ValueError, RecursionError) as exc:
        print(f"Startup failed: {exc}", file=sys.stderr)
        return 1
    server.store = store
    stopping = threading.Event()

    def stop(signum, frame):
        if not stopping.is_set():
            stopping.set()
            # shutdown() must run outside the serve_forever thread.
            threading.Thread(target=server.shutdown, name="shutdown").start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"LISTENING {server.server_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
