#!/usr/bin/env python3
"""Persistent, standard-library HTTP key/value service."""
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


def strict_json(data):
    def invalid(value):
        raise ValueError(f'invalid JSON number: {value}')
    return json.loads(data, parse_constant=invalid)


def encode(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8')


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            entries = strict_json(self.path.read_bytes())
            if not isinstance(entries, dict):
                raise ValueError('invalid persisted state')
            for key, entry in entries.items():
                validate_key(key)
                if not isinstance(entry, dict) or set(entry) != {'value', 'expires_at'}:
                    raise ValueError('invalid persisted entry')
                expiry = entry['expires_at']
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('invalid persisted expiration')
            encode(entries)
            self.entries = entries
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.commit(self.live())

    def live(self):
        now = time.time()
        return {k: v for k, v in self.entries.items()
                if v['expires_at'] is None or v['expires_at'] > now}

    def commit(self, entries):
        payload = encode(entries)
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix='.' + self.path.name + '.', delete=False) as stream:
                name = stream.name
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
            self.entries = entries
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            if method == 'PUT':
                status = 200 if key in entries else 201
                expiry = None if ttl is None else time.time() + ttl
                if expiry is not None and not math.isfinite(expiry):
                    raise ValueError('TTL is too large')
                entries[key] = {'value': value, 'expires_at': expiry}
                result = {'key': key, 'value': value}
            elif method == 'DELETE':
                status = 204 if key in entries else 404
                entries.pop(key, None)
                result = None if status == 204 else {'error': 'key not found'}
            elif key is None:
                status, result = 200, {'keys': sorted(entries)}
            elif key in entries:
                status, result = 200, {'key': key, 'value': entries[key]['value']}
            else:
                status, result = 404, {'error': 'key not found'}
            if entries != self.entries or method == 'PUT':
                self.commit(entries)
            return status, result


def validate_key(key):
    if not isinstance(key, str) or not key or '/' in key:
        raise ValueError('key must be nonempty and must not contain /')
    key.encode('utf-8', errors='strict')


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also prevents unread invalid bodies becoming requests.
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def send_json(self, status, body):
        payload = b'' if body is None else encode(body)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('error',))[0]})

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.handle_api
        raise AttributeError(name)

    def handle_api(self):
        try:
            if self.headers.get('Transfer-Encoding') is not None:
                self.send_error(400, 'Transfer-Encoding is not supported')
                return
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
                raise ValueError('invalid Content-Length')
            length = int(lengths[0]) if lengths else 0
            if length > MAX_BODY:
                self.send_error(413, 'request body exceeds 1 MiB')
                self.wfile.flush()
                # Let clients finish sending before closing, so TCP does not
                # discard the error response when unread request bytes remain.
                deadline = time.monotonic() + 2
                try:
                    while length:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            break
                        self.connection.settimeout(remaining)
                        chunk = self.rfile.read1(min(length, 65536))
                        if not chunk:
                            break
                        length -= len(chunk)
                except OSError:
                    pass
                return
            path = urlsplit(self.path).path
            key = None
            if path.startswith('/v1/kv/'):
                raw = path[len('/v1/kv/'):]
                if re.search(r'%(?![0-9a-fA-F]{2})', raw):
                    raise ValueError('invalid percent encoding')
                key = unquote_to_bytes(raw).decode('utf-8', errors='strict')
                validate_key(key)
                allowed = {'GET', 'PUT', 'DELETE'}
            elif path in ('/v1/keys', '/health'):
                allowed = {'GET'}
            else:
                self.send_error(404, 'unknown route')
                return
            if self.command not in allowed:
                self.send_error(405, 'method not allowed')
                return
            value, ttl = None, None
            if self.command == 'PUT':
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError('incomplete request body')
                body = strict_json(data.decode('utf-8'))
                if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
                    raise ValueError('expected value and optional ttl_seconds')
                value = body['value']
                encode(value)
                if 'ttl_seconds' in body:
                    ttl = body['ttl_seconds']
                    if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0:
                        raise ValueError('ttl_seconds must be finite and greater than zero')
            if path == '/health':
                self.send_json(200, {'status': 'ok'})
            else:
                self.send_json(*self.server.store.operate(self.command, key, value, ttl))
        except (ValueError, UnicodeError, OverflowError, RecursionError) as exc:
            self.send_error(400, str(exc))
        except TimeoutError:
            self.send_error(408, 'request timed out')
        except OSError as exc:
            print(f'request failed: {exc}', file=sys.stderr, flush=True)
            try:
                self.send_error(500, 'storage or connection failure')
            except OSError:
                pass


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--data', required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
    except (OSError, ValueError, OverflowError) as exc:
        print(f'startup failed: {exc}', file=sys.stderr)
        return 1
    server.store = store
    stopping = threading.Event()

    def stop(signum, frame):
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f'LISTENING {server.server_port}', flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
