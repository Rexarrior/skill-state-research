#!/usr/bin/env python3
"""A small, durable HTTP key-value store using only the standard library."""

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


def finite_float(text):
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("non-finite number")
    return value


def reject_constant(text):
    raise ValueError("invalid JSON constant: " + text)


def decode_json(raw):
    return json.loads(raw, parse_float=finite_float, parse_constant=reject_constant)


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False,
                      separators=(",", ":")).encode("utf-8")


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            data = decode_json(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != 1:
                raise ValueError("unsupported data file format")
            entries = data.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("invalid entries in data file")
            for key, entry in entries.items():
                if not key or "/" in key or not isinstance(entry, dict):
                    raise ValueError("invalid persisted entry")
                key.encode("utf-8")
                if set(entry) != {"value", "expires_at"}:
                    raise ValueError("invalid persisted entry fields")
                expiry = entry["expires_at"]
                if expiry is not None and (type(expiry) not in (int, float)
                                           or not math.isfinite(expiry)):
                    raise ValueError("invalid persisted expiration")
            self.entries = entries
        live = self._live(time.time())
        if live != self.entries:
            self._save(live)
            self.entries = live

    def _live(self, now):
        return {key: entry for key, entry in self.entries.items()
                if entry["expires_at"] is None or entry["expires_at"] > now}

    def _save(self, entries):
        payload = encode_json({"version": 1, "entries": entries})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix="." + self.path.name + ".",
                                    dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def execute(self, method, key=None, value=None, ttl=None):
        # Hold the lock through persistence so requests cannot lose updates or
        # observe a mutation that has not successfully reached the data file.
        with self.lock:
            now = time.time()
            live = self._live(now)
            if method == "PUT":
                expiry = None if ttl is None else now + ttl
                if expiry is not None and not math.isfinite(expiry):
                    raise ValueError("TTL expiration is out of range")
                status = 200 if key in live else 201
                live[key] = {"value": value, "expires_at": expiry}
                result = {"key": key, "value": value}
            elif method == "DELETE":
                status = 204 if key in live else 404
                live.pop(key, None)
                result = None if status == 204 else {"error": "key not found"}
            elif key is None:
                status, result = 200, {"keys": sorted(live)}
            elif key in live:
                status, result = 200, {"key": key, "value": live[key]["value"]}
            else:
                status, result = 404, {"error": "key not found"}
            if method == "PUT" or live != self.entries:
                self._save(live)
                self.entries = live
            return status, result


class Handler(BaseHTTPRequestHandler):
    server_version = "HTTPKV/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def send_json(self, status, value, allow=None):
        body = b"" if status == 204 else encode_json(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        if allow:
            self.send_header("Allow", allow)
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {"error": message or self.responses.get(code, ("error",))[0]})

    def route(self):
        path = urlsplit(self.path).path
        if path in ("/health", "/v1/keys"):
            return path, None
        prefix = "/v1/kv/"
        if not path.startswith(prefix):
            return None, None
        encoded = path[len(prefix):]
        if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
            raise ValueError("invalid key encoding")
        key = unquote_to_bytes(encoded).decode("utf-8", errors="strict")
        if not key or "/" in key:
            raise ValueError("key must be nonempty and cannot contain '/' ")
        return "kv", key

    def handle_api(self):
        try:
            if self.headers.get_all("Transfer-Encoding"):
                self.send_json(400, {"error": "transfer encoding is unsupported"})
                return
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
                raise ValueError("invalid Content-Length")
            length = int(lengths[0]) if lengths else 0
            if length > MAX_BODY:
                self.send_json(413, {"error": "request body exceeds 1 MiB"})
                return
            route, key = self.route()
            if route is None:
                self.send_json(404, {"error": "unknown route"})
                return
            allowed = ("GET", "PUT", "DELETE") if route == "kv" else ("GET",)
            if self.command not in allowed:
                self.send_json(405, {"error": "method not allowed"}, ", ".join(allowed))
                return
            value, ttl = None, None
            if self.command == "PUT" or length:
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("incomplete request body")
                body = decode_json(raw.decode("utf-8"))
                if self.command == "PUT":
                    if (not isinstance(body, dict) or "value" not in body
                            or set(body) - {"value", "ttl_seconds"}):
                        raise ValueError("expected value and optional ttl_seconds fields")
                    value = body["value"]
                    if "ttl_seconds" in body:
                        ttl = body["ttl_seconds"]
                        if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0:
                            raise ValueError("ttl_seconds must be finite and positive")
            if route == "/health":
                status, response = 200, {"status": "ok"}
            else:
                status, response = self.server.store.execute(self.command, key, value, ttl)
            self.send_json(status, response)
        except (ValueError, UnicodeError, OverflowError, RecursionError) as exc:
            self.send_json(400, {"error": str(exc) or "invalid request"})
        except TimeoutError:
            self.send_json(408, {"error": "request timed out"})
        except OSError as exc:
            self.log_error("request failed: %s", exc)
            try:
                self.send_json(500, {"error": "storage or connection failure"})
            except OSError:
                pass

    # BaseHTTPRequestHandler ordinarily emits HTML/501 for unknown methods.
    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.handle_api
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
    except (OSError, ValueError, OverflowError, RecursionError) as exc:
        print(f"startup failed: {exc}", file=sys.stderr)
        return 1
    server.store = store
    stopping = threading.Event()

    def stop(signum, frame):
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

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
