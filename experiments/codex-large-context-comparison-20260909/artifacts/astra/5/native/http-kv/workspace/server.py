#!/usr/bin/env python3
"""A small, durable HTTP key-value service using only the standard library."""

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


def valid_key(key):
    if not isinstance(key, str) or not key or "/" in key:
        return False
    try:
        key.encode("utf-8")
    except UnicodeError:
        return False
    return True


def valid_number(value):
    try:
        return (isinstance(value, (int, float)) and not isinstance(value, bool)
                and math.isfinite(value))
    except OverflowError:
        return False


class Store:
    def __init__(self, path):
        self.path = Path(path).absolute()
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            document = decode_json(self.path.read_bytes())
            if (not isinstance(document, dict) or document.get("version") != 1
                    or not isinstance(document.get("entries"), dict)):
                raise ValueError("Invalid data file")
            for key, entry in document["entries"].items():
                if (not valid_key(key) or not isinstance(entry, dict)
                        or set(entry) != {"value", "expires_at"}
                        or (entry["expires_at"] is not None
                            and not valid_number(entry["expires_at"]))):
                    raise ValueError("Invalid persisted entry")
            self.entries = self.live(document["entries"])
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def live(entries):
        now = time.time()
        return {key: entry for key, entry in entries.items()
                if entry["expires_at"] is None or entry["expires_at"] > now}

    def persist(self, entries):
        # Replace only after a complete file has been written and synced. Keep
        # the lock through disk I/O so memory, disk, and responses agree.
        payload = json.dumps({"version": 1, "entries": entries},
                             ensure_ascii=True, allow_nan=False).encode("utf-8")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent,
                                             prefix=f".{self.path.name}.",
                                             delete=False) as stream:
                temporary = stream.name
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            temporary = None
            self.entries = entries
            # Sync the directory entry as well where the OS supports it.
            try:
                descriptor = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            except OSError as exc:
                print(f"Directory sync unavailable: {exc}", file=sys.stderr)
        finally:
            if temporary is not None:
                os.unlink(temporary)

    def execute(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live(self.entries)
            if method == "keys":
                return 200, {"keys": sorted(entries)}
            if method == "GET":
                if key not in entries:
                    return 404, {"error": "Key not found"}
                return 200, {"key": key, "value": entries[key]["value"]}
            if method == "DELETE":
                if key not in entries:
                    return 404, {"error": "Key not found"}
                del entries[key]
                self.persist(entries)
                return 204, None
            status = 200 if key in entries else 201
            expires_at = None if ttl is None else time.time() + ttl
            if expires_at is not None and not math.isfinite(expires_at):
                return 400, {"error": "TTL is too large"}
            entries[key] = {"value": value, "expires_at": expires_at}
            self.persist(entries)
            return status, {"key": key, "value": value}


class RequestError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def finish(self):
        try:
            super().finish()
        finally:
            # Let clients receive the response even when rejected request data
            # is still arriving. Bound draining by time, not declared length.
            try:
                self.connection.shutdown(socket.SHUT_WR)
                deadline = time.monotonic() + 0.25
                while time.monotonic() < deadline:
                    self.connection.settimeout(max(0.001, deadline - time.monotonic()))
                    if not self.connection.recv(65536):
                        break
            except OSError:
                pass

    def respond(self, status, body):
        payload = b"" if body is None else json.dumps(
            body, ensure_ascii=True, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if status != 204:
            self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD" and payload:
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.respond(code, {"error": message or self.responses.get(code, ("Error",))[0]})

    def read_body(self):
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError(400, "Transfer-Encoding is not supported")
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths:
            if self.command == "PUT":
                raise RequestError(411, "Content-Length is required")
            return None
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
            raise RequestError(400, "Invalid Content-Length")
        # Avoid converting unbounded decimal strings to integers.
        digits = lengths[0].lstrip("0") or "0"
        if len(digits) > 7 or int(digits) > MAX_BODY:
            raise RequestError(413, "Request body exceeds 1 MiB")
        size = int(digits)
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise RequestError(400, "Incomplete request body")
        if not raw and self.command != "PUT":
            return None
        try:
            return decode_json(raw)
        except (ValueError, UnicodeError, RecursionError):
            raise RequestError(400, "Malformed JSON") from None

    def dispatch(self):
        try:
            body = self.read_body()
            path = urlsplit(self.path).path
            if path == "/health":
                if self.command != "GET":
                    raise RequestError(405, "Method not allowed")
                result = 200, {"status": "ok"}
            elif path == "/v1/keys":
                if self.command != "GET":
                    raise RequestError(405, "Method not allowed")
                result = self.server.store.execute("keys")
            elif path.startswith("/v1/kv/"):
                encoded = path[len("/v1/kv/"):]
                if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
                    raise RequestError(400, "Invalid key encoding")
                try:
                    key = unquote_to_bytes(encoded).decode("utf-8")
                except UnicodeError:
                    raise RequestError(400, "Key must be UTF-8") from None
                if not valid_key(key):
                    raise RequestError(400, "Key must be nonempty and contain no slash")
                if self.command not in ("GET", "PUT", "DELETE"):
                    raise RequestError(405, "Method not allowed")
                ttl = None
                if self.command == "PUT":
                    if (not isinstance(body, dict) or "value" not in body
                            or set(body) - {"value", "ttl_seconds"}):
                        raise RequestError(400, "Expected value and optional ttl_seconds")
                    if "ttl_seconds" in body:
                        ttl = body["ttl_seconds"]
                        if not valid_number(ttl) or ttl <= 0:
                            raise RequestError(400, "TTL must be finite and greater than zero")
                result = self.server.store.execute(
                    self.command, key, body["value"] if self.command == "PUT" else None, ttl)
            else:
                raise RequestError(404, "Unknown route")
            self.respond(*result)
        except RequestError as exc:
            self.respond(exc.status, {"error": exc.message})
        except TimeoutError:
            self.respond(408, {"error": "Request timed out"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (ValueError, RecursionError):
            self.respond(400, {"error": "Invalid request"})
        except OSError as exc:
            print(f"Storage error: {exc}", file=sys.stderr)
            self.respond(500, {"error": "Storage operation failed"})

    # BaseHTTPRequestHandler dispatches all methods through do_METHOD.
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
    except (OSError, ValueError, RecursionError) as exc:
        print(f"Startup failed: {exc}", file=sys.stderr)
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
