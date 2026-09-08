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


def decode_json(raw):
    return json.loads(raw, parse_constant=reject_constant)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            data = decode_json(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("entries"), dict):
                raise ValueError("Invalid state file")
            for key, entry in data["entries"].items():
                if not key or "/" in key or not isinstance(entry, dict) or "value" not in entry or "expires_at" not in entry:
                    raise ValueError("Invalid persisted entry")
                key.encode("utf-8")
                expiry = entry["expires_at"]
                if expiry is not None and (isinstance(expiry, bool) or not isinstance(expiry, (int, float)) or not math.isfinite(expiry)):
                    raise ValueError("Invalid persisted expiration")
            self.entries = data["entries"]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.entries = self.live()
        self.persist(self.entries)

    def live(self):
        now = time.time()
        return {k: v for k, v in self.entries.items() if v["expires_at"] is None or v["expires_at"] > now}

    def persist(self, entries):
        # Write and sync a sibling file before replacing the committed snapshot.
        name = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, prefix=f".{self.path.name}.", delete=False) as stream:
                name = stream.name
                json.dump({"version": 1, "entries": entries}, stream, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            present = key in entries
            if method == "PUT":
                expiry = None if ttl is None else time.time() + ttl
                if expiry is not None and not math.isfinite(expiry):
                    raise ValueError("TTL expiration is out of range")
                entries[key] = {"value": value, "expires_at": expiry}
                result = (200 if present else 201, {"key": key, "value": value})
            elif method == "DELETE":
                if present:
                    del entries[key]
                result = (204, None) if present else (404, {"error": "Key not found"})
            elif method == "GET":
                result = (200, {"key": key, "value": entries[key]["value"]}) if present else (404, {"error": "Key not found"})
            else:
                result = (200, {"keys": sorted(entries)})
            if method == "PUT" or entries != self.entries:
                self.persist(entries)
                self.entries = entries
            return result


class Handler(BaseHTTPRequestHandler):
    # Closing each connection avoids ambiguous framing and keeps shutdown bounded.
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def send_json(self, status, payload):
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.dispatch
        raise AttributeError(name)

    def dispatch(self):
        try:
            self.handle_api()
        except (ValueError, UnicodeError, RecursionError, OverflowError) as exc:
            self.send_json(400, {"error": str(exc) or "Invalid request"})
        except TimeoutError:
            self.send_json(408, {"error": "Request timed out"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            print(f"Request failed: {exc}", file=sys.stderr, flush=True)
            self.send_json(500, {"error": "Internal server error"})

    def handle_api(self):
        if self.headers.get("Transfer-Encoding") is not None:
            self.send_json(400, {"error": "Transfer-Encoding is unsupported"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
            raise ValueError("Invalid Content-Length")
        length = int(lengths[0]) if lengths else 0
        if length > MAX_BODY:
            self.send_json(413, {"error": "Request body exceeds 1 MiB"})
            return
        path = urlsplit(self.path).path
        key = None
        if path.startswith("/v1/kv/"):
            encoded = path[len("/v1/kv/"):]
            if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
                raise ValueError("Invalid percent-encoded key")
            key = unquote(encoded, encoding="utf-8", errors="strict")
            if not key or "/" in key:
                raise ValueError("Key must be nonempty and contain no slash")
            key.encode("utf-8")
            allowed = {"PUT", "GET", "DELETE"}
        elif path in ("/health", "/v1/keys"):
            allowed = {"GET"}
        else:
            self.send_json(404, {"error": "Unknown route"})
            return
        if self.command not in allowed:
            self.send_json(405, {"error": "Method not allowed"})
            return
        if self.command == "PUT":
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete request body")
            body = decode_json(raw.decode("utf-8"))
            if not isinstance(body, dict) or "value" not in body:
                raise ValueError("Body must be an object containing value")
            ttl = body.get("ttl_seconds")
            if "ttl_seconds" in body:
                if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0:
                    raise ValueError("ttl_seconds must be finite and greater than zero")
            # Reject numeric overflow (e.g. 1e999) anywhere in the value.
            json.dumps(body["value"], allow_nan=False)
            status, payload = self.server.store.operate("PUT", key, body["value"], ttl)
        elif path == "/health":
            status, payload = 200, {"status": "ok"}
        else:
            status, payload = self.server.store.operate("LIST" if path == "/v1/keys" else self.command, key)
        self.send_json(status, payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = ThreadingHTTPServer((args.host, args.port), Handler)
        # Wait for bounded request threads before exiting.
        server.daemon_threads = False
        server.store = store
    except Exception as exc:
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
