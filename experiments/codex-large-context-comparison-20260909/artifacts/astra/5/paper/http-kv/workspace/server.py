#!/usr/bin/env python3
"""A small persistent JSON key-value HTTP service (Python 3.11+)."""
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
    raise ValueError(f'invalid JSON constant: {value}')


def loads(raw):
    value = json.loads(raw, parse_constant=reject_constant)
    # Also reject finite-looking literals that overflow Python's float.
    json.dumps(value, allow_nan=False)
    return value


def valid_key(key):
    if not isinstance(key, str) or not key or '/' in key:
        return False
    try:
        key.encode('utf-8')
    except UnicodeError:
        return False
    return True


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            snapshot = loads(self.path.read_text(encoding='utf-8'))
            if not isinstance(snapshot, dict) or snapshot.get('version') != 1 or not isinstance(snapshot.get('entries'), dict):
                raise ValueError('invalid snapshot format')
            for key, entry in snapshot['entries'].items():
                if not valid_key(key) or not isinstance(entry, dict) or set(entry) != {'value', 'expires_at'}:
                    raise ValueError('invalid snapshot entry')
                expiry = entry['expires_at']
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('invalid snapshot expiration')
            self.entries = self.live(snapshot['entries'])
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.persist(self.entries)

    @staticmethod
    def live(entries):
        now = time.time()
        return {key: entry for key, entry in entries.items()
                if entry['expires_at'] is None or entry['expires_at'] > now}

    def persist(self, entries):
        name = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent,
                                             prefix=f'.{self.path.name}.', delete=False) as file:
                name = file.name
                json.dump({'version': 1, 'entries': entries}, file, allow_nan=False)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)

    def execute(self, method, key=None, value=None, ttl=None):
        with self.lock:
            live = self.live(self.entries)
            if method == 'PUT':
                status = 200 if key in live else 201
                live[key] = {'value': value, 'expires_at': None if ttl is None else time.time() + ttl}
                self.persist(live)
                self.entries = live
                return status, {'key': key, 'value': value}
            if method == 'DELETE':
                if key not in live:
                    return 404, {'error': 'key not found'}
                del live[key]
                self.persist(live)
                self.entries = live
                return 204, None
            self.entries = live
            if method == 'KEYS':
                return 200, {'keys': sorted(live)}
            if key not in live:
                return 404, {'error': 'key not found'}
            return 200, {'key': key, 'value': live[key]['value']}


class RequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def send_json(self, status, payload):
        body = b'' if status == 204 else json.dumps(payload, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        if self.command != 'HEAD':
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('request error',))[0]})

    def __getattr__(self, name):
        # BaseHTTPRequestHandler dispatches arbitrary method names via do_*.
        if name.startswith('do_'):
            return self.handle_request
        raise AttributeError(name)

    def handle_request(self):
        try:
            lengths = self.headers.get_all('Content-Length', [])
            if self.headers.get('Transfer-Encoding') is not None:
                raise RequestError(400, 'transfer encoding is unsupported')
            if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
                raise RequestError(400, 'invalid Content-Length')
            try:
                length = int(lengths[0]) if lengths else 0
            except ValueError:
                raise RequestError(413, 'request body exceeds 1 MiB')
            if length > MAX_BODY:
                self.send_json(413, {'error': 'request body exceeds 1 MiB'})
                # Let ordinary clients finish sending before closing the socket,
                # so they can read the error. Bound both draining time and bytes.
                deadline = time.monotonic() + 2
                remaining = min(length, 8 * MAX_BODY)
                try:
                    while remaining and time.monotonic() < deadline:
                        self.connection.settimeout(max(0.001, deadline - time.monotonic()))
                        chunk = self.rfile.read1(min(65536, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                except OSError:
                    pass
                return
            if self.command not in ('GET', 'PUT', 'DELETE'):
                raise RequestError(405, 'unsupported method')
            path = urlsplit(self.path).path
            if path == '/health':
                if self.command != 'GET':
                    raise RequestError(405, 'unsupported method')
                self.send_json(200, {'status': 'ok'})
                return
            if path == '/v1/keys':
                if self.command != 'GET':
                    raise RequestError(405, 'unsupported method')
                self.send_json(*self.server.store.execute('KEYS'))
                return
            if not path.startswith('/v1/kv/'):
                raise RequestError(404, 'unknown route')
            encoded = path[len('/v1/kv/'):]
            if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
                raise RequestError(400, 'invalid key encoding')
            try:
                key = unquote_to_bytes(encoded).decode('utf-8', errors='strict')
            except UnicodeError:
                raise RequestError(400, 'invalid key encoding')
            if not valid_key(key):
                raise RequestError(400, 'invalid key')
            value = ttl = None
            if self.command == 'PUT':
                if not lengths:
                    raise RequestError(411, 'Content-Length required')
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise RequestError(400, 'incomplete request body')
                try:
                    body = loads(raw.decode('utf-8'))
                except (ValueError, UnicodeError, RecursionError):
                    raise RequestError(400, 'invalid JSON')
                if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
                    raise RequestError(400, 'expected value and optional ttl_seconds')
                value = body['value']
                if 'ttl_seconds' in body:
                    ttl = body['ttl_seconds']
                    try:
                        valid = type(ttl) in (int, float) and math.isfinite(ttl) and ttl > 0 and math.isfinite(time.time() + ttl)
                    except OverflowError:
                        valid = False
                    if not valid:
                        raise RequestError(400, 'ttl_seconds must be finite and positive')
            self.send_json(*self.server.store.execute(self.command, key, value, ttl))
        except RequestError as exc:
            self.send_json(exc.status, {'error': exc.message})
        except (TimeoutError, ValueError) as exc:
            self.send_json(400, {'error': str(exc)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            print(f'request failed: {exc}', file=sys.stderr, flush=True)
            self.send_json(500, {'error': 'internal server error'})


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
