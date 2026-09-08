#!/usr/bin/env python3
"""Dependency-free persistent JSON key-value HTTP service."""
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
from urllib.parse import unquote, urlsplit

MAX_BODY = 1024 * 1024


def reject_constant(value):
    raise ValueError(f"Invalid JSON number: {value}")


def decode_json(data):
    return json.loads(data, parse_constant=reject_constant)


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            document = decode_json(self.path.read_text(encoding="utf-8"))
            if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("entries"), dict):
                raise ValueError("Invalid persistence file")
            for key, entry in document["entries"].items():
                if not valid_key(key) or not isinstance(entry, dict) or set(entry) != {"value", "expires_at"}:
                    raise ValueError("Invalid persisted entry")
                expiry = entry["expires_at"]
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError("Invalid persisted expiration")
            encode_json(document)  # Reject non-finite values anywhere in stored JSON.
            self.entries = document["entries"]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.commit(self.live())

    def live(self):
        now = time.time()
        return {key: entry for key, entry in self.entries.items()
                if entry["expires_at"] is None or entry["expires_at"] > now}

    def commit(self, entries):
        payload = encode_json({"version": 1, "entries": entries})
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=f".{self.path.name}.", delete=False) as stream:
                temporary = stream.name
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            temporary = None
            self.entries = entries
        finally:
            if temporary is not None:
                os.unlink(temporary)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            present = key in entries
            if method == "PUT":
                expiry = None if ttl is None else time.time() + ttl
                if expiry is not None and not math.isfinite(expiry):
                    raise ValueError("TTL expiration is out of range")
                entries[key] = {"value": value, "expires_at": expiry}
                self.commit(entries)
                return (200 if present else 201), {"key": key, "value": value}
            if method == "DELETE" and present:
                del entries[key]
            if entries != self.entries:
                self.commit(entries)
            if method == "KEYS":
                return 200, {"keys": sorted(entries)}
            if not present:
                return 404, {"error": "Key not found"}
            if method == "DELETE":
                return 204, None
            return 200, {"key": key, "value": entries[key]["value"]}


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also prevents unread/ambiguous bodies being reused.
    protocol_version = "HTTP/1.0"

    def respond(self, status, body):
        payload = b"" if status == 204 else encode_json(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.respond(code, {"error": message or self.responses.get(code, ("Request error",))[0]})

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.dispatch
        raise AttributeError(name)

    def dispatch(self):
        try:
            self.handle_api()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (OSError, ValueError, OverflowError, RecursionError) as error:
            self.log_error("Request failed: %s", error)
            self.respond(500, {"error": "Storage or processing failure"})

    def handle_api(self):
        if self.headers.get("Transfer-Encoding") is not None:
            self.respond(400, {"error": "Transfer-Encoding is not supported"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
            self.respond(400, {"error": "Invalid Content-Length"})
            return
        # Compare as text first to avoid converting unbounded integer headers.
        text_length = lengths[0].lstrip("0") or "0" if lengths else "0"
        if len(text_length) > 7 or int(text_length) > MAX_BODY:
            self.respond(413, {"error": "Request body exceeds 1 MiB"})
            return
        length = int(text_length)
        if self.command not in {"GET", "PUT", "DELETE"}:
            self.respond(405, {"error": "Unsupported method"})
            return
        try:
            path = urlsplit(self.path).path
        except ValueError:
            self.respond(400, {"error": "Invalid URL"})
            return
        key = None
        if path.startswith("/v1/kv/"):
            raw = path[len("/v1/kv/"):]
            try:
                if re.search(r"%(?![0-9a-fA-F]{2})", raw):
                    raise ValueError("Invalid escape")
                key = unquote(raw, encoding="utf-8", errors="strict")
                if not valid_key(key):
                    raise ValueError("Invalid key")
            except (ValueError, UnicodeError):
                self.respond(400, {"error": "Invalid key"})
                return
        elif path not in {"/health", "/v1/keys"}:
            self.respond(404, {"error": "Unknown route"})
            return
        elif self.command != "GET":
            self.respond(405, {"error": "Unsupported method for route"})
            return

        body = None
        if length or self.command == "PUT":
            self.connection.settimeout(10)
            try:
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError("Incomplete body")
                body = decode_json(data.decode("utf-8"))
                encode_json(body)
            except TimeoutError:
                self.respond(408, {"error": "Request body timed out"})
                return
            except (ValueError, UnicodeError, RecursionError, OverflowError):
                self.respond(400, {"error": "Invalid JSON body"})
                return
        if path == "/health":
            self.respond(200, {"status": "ok"})
        elif path == "/v1/keys":
            self.respond(*self.server.store.operate("KEYS"))
        elif self.command == "PUT":
            if not isinstance(body, dict) or "value" not in body or set(body) - {"value", "ttl_seconds"}:
                self.respond(400, {"error": "Expected value and optional ttl_seconds"})
                return
            ttl = body.get("ttl_seconds")
            if "ttl_seconds" in body:
                try:
                    if type(ttl) not in (int, float) or ttl <= 0 or not math.isfinite(ttl) or not math.isfinite(time.time() + ttl):
                        raise ValueError("Invalid TTL")
                except (ValueError, OverflowError):
                    self.respond(400, {"error": "TTL must be finite and greater than zero"})
                    return
            self.respond(*self.server.store.operate("PUT", key, body["value"], ttl))
        else:
            self.respond(*self.server.store.operate(self.command, key))


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
    except (OSError, ValueError, OverflowError, RecursionError) as error:
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
