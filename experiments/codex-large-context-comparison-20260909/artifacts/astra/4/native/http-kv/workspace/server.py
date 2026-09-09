#!/usr/bin/env python3
"""A small, durable HTTP key-value service using only the standard library."""

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
from urllib.parse import unquote_to_bytes


MAX_BODY = 1024 * 1024


def reject_constant(value):
    raise ValueError(f"Invalid JSON number: {value}")


def decode_json(raw):
    return json.loads(raw.decode("utf-8"), parse_constant=reject_constant)


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False,
                      separators=(",", ":")).encode("utf-8")


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8")
    except UnicodeError:
        return False
    return True


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            document = decode_json(self.path.read_bytes())
            if (not isinstance(document, dict) or document.get("version") != 1
                    or not isinstance(document.get("entries"), dict)):
                raise ValueError("Invalid data file")
            for key, entry in document["entries"].items():
                if (not valid_key(key) or not isinstance(entry, dict)
                        or set(entry) != {"value", "expires_at"}):
                    raise ValueError("Invalid persisted entry")
                expires = entry["expires_at"]
                if expires is not None and (type(expires) not in (int, float)
                                            or not math.isfinite(expires)):
                    raise ValueError("Invalid persisted expiration")
                encode_json(entry)
            self.entries = document["entries"]
            self.prune()

    def prune(self):
        now = time.time()
        self.entries = {k: v for k, v in self.entries.items()
                        if v["expires_at"] is None or v["expires_at"] > now}

    def persist(self, entries):
        payload = encode_json({"version": 1, "entries": entries})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent,
                                             prefix=f".{self.path.name}.",
                                             delete=False) as output:
                temporary = output.name
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    def execute(self, method, key=None, value=None, ttl=None):
        with self.lock:
            self.prune()
            if method == "keys":
                return 200, {"keys": sorted(self.entries)}
            if method == "GET":
                if key not in self.entries:
                    return 404, {"error": "Key not found"}
                return 200, {"key": key, "value": self.entries[key]["value"]}
            updated = self.entries.copy()
            if method == "PUT":
                status = 200 if key in updated else 201
                updated[key] = {"value": value,
                                "expires_at": time.time() + ttl if ttl else None}
            else:
                if key not in updated:
                    return 404, {"error": "Key not found"}
                del updated[key]
                status = 204
            self.persist(updated)
            self.entries = updated
            return status, {"key": key, "value": value} if method == "PUT" else None


class Handler(BaseHTTPRequestHandler):
    # Close each connection to avoid ambiguities from unread/rejected bodies.
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def respond(self, status, body=None):
        raw = b"" if body is None else encode_json(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def send_error(self, code, message=None, explain=None):
        # Also covers errors raised by the HTTP parser and unknown methods.
        self.respond(405 if code == 501 else code,
                     {"error": message or self.responses.get(code, ("Error",))[0]})

    def dispatch(self):
        try:
            if self.headers.get("Transfer-Encoding") is not None:
                self.respond(400, {"error": "Transfer-Encoding is unsupported"})
                return
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
                self.respond(400, {"error": "Invalid Content-Length"})
                return
            if lengths and (len(lengths[0]) > 10 or int(lengths[0]) > MAX_BODY):
                self.respond(413, {"error": "Request body exceeds 1 MiB"})
                return
            path = self.path.partition("?")[0]
            if path in ("/health", "/v1/keys"):
                if self.command != "GET":
                    self.respond(405, {"error": "Method not allowed"})
                elif path == "/health":
                    self.respond(200, {"status": "ok"})
                else:
                    self.respond(*self.server.store.execute("keys"))
                return
            if not path.startswith("/v1/kv/"):
                self.respond(404, {"error": "Route not found"})
                return
            encoded = path[len("/v1/kv/"):]
            if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
                raise ValueError("Invalid key encoding")
            key = unquote_to_bytes(encoded).decode("utf-8")
            if not valid_key(key):
                raise ValueError("Invalid key")
            if self.command not in ("GET", "PUT", "DELETE"):
                self.respond(405, {"error": "Method not allowed"})
                return
            if self.command == "PUT":
                if not lengths:
                    self.respond(411, {"error": "Content-Length is required"})
                    return
                length = int(lengths[0])
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("Incomplete request body")
                body = decode_json(raw)
                if not isinstance(body, dict) or "value" not in body:
                    raise ValueError("Body must be an object containing value")
                ttl = body.get("ttl_seconds")
                if "ttl_seconds" in body:
                    if (type(ttl) not in (int, float) or not math.isfinite(ttl)
                            or ttl <= 0 or not math.isfinite(time.time() + ttl)):
                        raise ValueError("TTL must be finite and greater than zero")
                encode_json(body["value"])
                self.respond(*self.server.store.execute("PUT", key, body["value"], ttl))
            else:
                self.respond(*self.server.store.execute(self.command, key))
        except (ValueError, UnicodeError, OverflowError, RecursionError) as error:
            self.respond(400, {"error": str(error)})
        except TimeoutError:
            self.respond(408, {"error": "Request timed out"})
        except OSError as error:
            self.log_error("Request failed: %s", error)
            self.respond(500, {"error": "Storage or connection failure"})

    do_GET = do_PUT = do_DELETE = do_POST = do_PATCH = do_HEAD = do_OPTIONS = dispatch


class Server(ThreadingHTTPServer):
    daemon_threads = False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
    except (OSError, ValueError, OverflowError) as error:
        print(f"Startup failed: {error}", file=sys.stderr)
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
