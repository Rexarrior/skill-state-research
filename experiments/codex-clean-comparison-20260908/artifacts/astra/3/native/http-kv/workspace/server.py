#!/usr/bin/env python3
"""Dependency-free, persistent HTTP key-value service (Python 3.11+)."""

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
from urllib.parse import unquote, urlsplit


MAX_BODY = 1024 * 1024


def finite_float(text):
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("Non-finite JSON number")
    return value


def reject_constant(text):
    raise ValueError("Invalid JSON constant: " + text)


def decode_json(data):
    return json.loads(data, parse_float=finite_float, parse_constant=reject_constant)


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False,
                      separators=(",", ":")).encode("utf-8")


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8")
        return True
    except UnicodeError:
        return False


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            data = decode_json(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("entries"), dict):
                raise ValueError("Invalid persistence file")
            for key, entry in data["entries"].items():
                if not valid_key(key) or not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("Invalid persisted entry")
                expiry = entry["expires_at"]
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError("Invalid persisted expiry")
            self.entries = data["entries"]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Validate writability at startup and remove entries that expired offline.
        self.commit(self.live())

    def live(self):
        now = time.time()
        return {key: entry for key, entry in self.entries.items()
                if entry["expires_at"] is None or entry["expires_at"] > now}

    def commit(self, entries):
        payload = encode_json({"version": 1, "entries": entries})
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent,
                                             prefix="." + self.path.name + ".",
                                             delete=False) as stream:
                temporary = stream.name
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            self.entries = entries
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    def access(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            if method == "keys":
                return 200, {"keys": sorted(entries)}
            if method == "GET":
                if key in entries:
                    return 200, {"key": key, "value": entries[key]["value"]}
            elif method == "PUT":
                status = 200 if key in entries else 201
                entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
                self.commit(entries)
                return status, {"key": key, "value": value}
            elif method == "DELETE" and key in entries:
                del entries[key]
                self.commit(entries)
                return 204, None
            return 404, {"error": "Key not found"}

    def close(self):
        with self.lock:
            self.commit(self.live())


class RequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    # Close each connection so rejected/unread bodies cannot become requests.
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def reply(self, status, body):
        payload = b"" if status == 204 else encode_json(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def body_length(self):
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(400, "Transfer-Encoding is unsupported")
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths:
            return 0
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
            raise RequestError(400, "Invalid Content-Length")
        # Avoid parsing an arbitrarily long integer.
        digits = lengths[0].lstrip("0") or "0"
        if len(digits) > 7 or int(digits) > MAX_BODY:
            raise RequestError(413, "Request body exceeds 1 MiB")
        return int(digits)

    def dispatch(self):
        try:
            length = self.body_length()
            path = urlsplit(self.path).path
            if path in ("/health", "/v1/keys"):
                if self.command != "GET":
                    raise RequestError(405, "Method not allowed")
                result = (200, {"status": "ok"}) if path == "/health" else self.server.store.access("keys")
            elif path.startswith("/v1/kv/"):
                encoded = path[len("/v1/kv/"):]
                if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
                    raise RequestError(400, "Invalid key encoding")
                key = unquote(encoded, encoding="utf-8", errors="strict")
                if not valid_key(key):
                    raise RequestError(400, "Invalid key")
                if self.command not in ("GET", "PUT", "DELETE"):
                    raise RequestError(405, "Method not allowed")
                if self.command == "PUT":
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise RequestError(400, "Incomplete request body")
                    body = decode_json(raw.decode("utf-8"))
                    if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                        raise RequestError(400, "Expected value and optional ttl_seconds")
                    ttl = body.get("ttl_seconds")
                    if "ttl_seconds" in body:
                        if type(ttl) not in (int, float) or ttl <= 0 or not math.isfinite(ttl) or not math.isfinite(time.time() + ttl):
                            raise RequestError(400, "TTL must be finite and greater than zero")
                    result = self.server.store.access("PUT", key, body["value"], ttl)
                else:
                    result = self.server.store.access(self.command, key)
            else:
                raise RequestError(404, "Unknown route")
            self.reply(*result)
        except RequestError as exc:
            self.reply(exc.status, {"error": exc.message})
            if exc.status == 413:
                # Let clients still uploading see the error instead of a reset.
                # Discard in small chunks with a bounded total drain time.
                try:
                    self.connection.shutdown(socket.SHUT_WR)
                    self.connection.settimeout(0.2)
                    deadline = time.monotonic() + 1
                    while time.monotonic() < deadline and self.rfile.read1(65536):
                        pass
                except OSError:
                    pass
        except (ValueError, UnicodeError, OverflowError, RecursionError):
            self.reply(400, {"error": "Invalid JSON, key, or number"})
        except TimeoutError:
            self.reply(408, {"error": "Request timed out"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as exc:
            print(f"Storage/request failure: {exc}", file=sys.stderr, flush=True)
            self.reply(500, {"error": "Internal server error"})

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.dispatch
        raise AttributeError(name)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
    except (OSError, ValueError, OverflowError) as exc:
        print(f"Startup failed: {exc}", file=sys.stderr, flush=True)
        return 1
    server.store = store
    stopped = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopped.set())
    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1})
    worker.start()
    print(f"LISTENING {server.server_port}", flush=True)
    try:
        stopped.wait()
    finally:
        server.shutdown()
        worker.join()
        server.server_close()
        try:
            store.close()
        except OSError as exc:
            print(f"Shutdown persistence failed: {exc}", file=sys.stderr, flush=True)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
