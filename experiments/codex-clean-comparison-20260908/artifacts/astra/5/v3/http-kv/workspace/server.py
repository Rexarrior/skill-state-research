#!/usr/bin/env python3
"""Dependency-free persistent HTTP key-value service."""
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
    raise ValueError(f"Invalid JSON constant: {value}")


def parse_json(raw):
    return json.loads(raw, parse_constant=reject_constant)


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            document = parse_json(self.path.read_text(encoding="utf-8"))
            if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("entries"), dict):
                raise ValueError("Invalid state file")
            for key, entry in document["entries"].items():
                if not valid_key(key) or not isinstance(entry, dict) or "value" not in entry:
                    raise ValueError("Invalid state entry")
                expiry = entry.get("expires_at")
                if expiry is not None and not finite_number(expiry):
                    raise ValueError("Invalid stored expiration")
                self.entries[key] = {"value": entry["value"], "expires_at": expiry}
            encode_json(self.entries)
        self.entries = self.live()

    def live(self):
        now = time.time()
        return {k: v for k, v in self.entries.items() if v["expires_at"] is None or v["expires_at"] > now}

    def persist(self, entries):
        payload = encode_json({"version": 1, "entries": entries})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix="." + self.path.name + ".", delete=False) as stream:
                temporary = stream.name
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            if method == "GET":
                self.entries = entries
                if key is None:
                    return 200, {"keys": sorted(entries)}
                if key not in entries:
                    return 404, {"error": "Key not found"}
                return 200, {"key": key, "value": entries[key]["value"]}
            if method == "PUT":
                status = 200 if key in entries else 201
                entries[key] = {"value": value, "expires_at": None if ttl is None else time.time() + ttl}
                body = {"key": key, "value": value}
            else:
                if key not in entries:
                    return 404, {"error": "Key not found"}
                del entries[key]
                status, body = 204, None
            self.persist(entries)
            self.entries = entries
            return status, body

    def close(self):
        with self.lock:
            entries = self.live()
            self.persist(entries)
            self.entries = entries


def finite_number(value):
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    except OverflowError:
        return False


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8", errors="strict")
        return True
    except UnicodeError:
        return False


class Handler(BaseHTTPRequestHandler):
    # One request per connection avoids unread rejected bodies affecting framing.
    protocol_version = "HTTP/1.0"

    def reply(self, status, body=None):
        raw = b"" if body is None else encode_json(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"error": message or "Bad request"})

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.unsupported
        raise AttributeError(name)

    def unsupported(self):
        self.reply(405, {"error": "Method not allowed"})

    def dispatch(self):
        try:
            self.handle_api()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.log_error("Request failed: %s", exc)
            self.reply(500, {"error": "Internal server error"})

    do_GET = do_PUT = do_DELETE = dispatch

    def handle_api(self):
        if self.headers.get("Transfer-Encoding") is not None:
            self.reply(400, {"error": "Transfer-Encoding is not supported"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
            self.reply(400, {"error": "Invalid Content-Length"})
            return
        try:
            size = int(lengths[0]) if lengths else 0
        except ValueError:
            size = MAX_BODY + 1
        if size > MAX_BODY:
            self.reply(413, {"error": "Request body exceeds 1 MiB"})
            return
        try:
            path = urlsplit(self.path).path
        except ValueError:
            self.reply(400, {"error": "Invalid URL"})
            return
        key = None
        if path.startswith("/v1/kv/"):
            encoded = path[len("/v1/kv/"):]
            try:
                if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
                    raise ValueError("Invalid percent escape")
                key = unquote(encoded, encoding="utf-8", errors="strict")
                if not valid_key(key):
                    raise ValueError("Invalid key")
            except (UnicodeError, ValueError):
                self.reply(400, {"error": "Invalid key"})
                return
        elif path not in ("/health", "/v1/keys"):
            self.reply(404, {"error": "Route not found"})
            return
        if key is None:
            if self.command != "GET":
                self.unsupported()
            elif path == "/health":
                self.reply(200, {"status": "ok"})
            else:
                self.reply(*self.server.store.operate("GET"))
            return
        if self.command == "PUT":
            try:
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise ValueError("Incomplete body")
                document = parse_json(raw.decode("utf-8"))
                if not isinstance(document, dict) or "value" not in document or set(document) - {"value", "ttl_seconds"}:
                    raise ValueError("Expected value and optional ttl_seconds")
                encode_json(document)
                ttl = document.get("ttl_seconds")
                if "ttl_seconds" in document and (not finite_number(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl)):
                    raise ValueError("TTL must be finite and greater than zero")
            except (ValueError, UnicodeError, OverflowError, RecursionError) as exc:
                self.reply(400, {"error": str(exc)})
                return
            self.reply(*self.server.store.operate("PUT", key, document["value"], ttl))
        else:
            self.reply(*self.server.store.operate(self.command, key))


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
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
        server.store = store
    except (OSError, ValueError) as exc:
        print(f"Startup failed: {exc}", file=sys.stderr)
        return 1
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
        try:
            store.close()
        except OSError as exc:
            print(f"Shutdown persistence failed: {exc}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
