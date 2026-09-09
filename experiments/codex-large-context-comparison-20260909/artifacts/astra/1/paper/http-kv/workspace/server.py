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
from urllib.parse import unquote_to_bytes, urlsplit

MAX_BODY = 1024 * 1024


def reject_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def parse_json(data):
    value = json.loads(data, parse_constant=reject_constant)
    # Also reject finite-looking literals which overflow Python floats.
    json.dumps(value, allow_nan=False)
    return value


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            raw = parse_json(self.path.read_text(encoding='utf-8'))
            if not isinstance(raw, dict) or raw.get('version') != 1 or not isinstance(raw.get('entries'), dict):
                raise ValueError('Invalid persistence file')
            for key, entry in raw['entries'].items():
                if not key or '/' in key or not isinstance(entry, dict) or 'value' not in entry or 'expires_at' not in entry:
                    raise ValueError('Invalid persisted entry')
                expiry = entry['expires_at']
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('Invalid persisted expiry')
            self.entries = self.live(raw['entries'])

    @staticmethod
    def live(entries):
        now = time.time()
        return {k: v for k, v in entries.items() if v['expires_at'] is None or v['expires_at'] > now}

    def persist(self, entries):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent, prefix='.' + self.path.name + '.', delete=False) as stream:
                temporary = stream.name
                json.dump({'version': 1, 'entries': entries}, stream, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    def request(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live(self.entries)
            if method == 'keys':
                self.entries = entries
                return 200, {'keys': sorted(entries)}
            if method == 'GET':
                self.entries = entries
                if key not in entries:
                    return 404, {'error': 'Key not found'}
                return 200, {'key': key, 'value': entries[key]['value']}
            if method == 'DELETE':
                if key not in entries:
                    return 404, {'error': 'Key not found'}
                del entries[key]
                status, result = 204, None
            else:
                status = 200 if key in entries else 201
                entries[key] = {'value': value, 'expires_at': None if ttl is None else time.time() + ttl}
                result = {'key': key, 'value': value}
            self.persist(entries)
            self.entries = entries
            return status, result


class Handler(BaseHTTPRequestHandler):
    # Close after each response so rejected/unread bodies cannot become requests.
    protocol_version = 'HTTP/1.0'

    def send_json(self, status, body):
        payload = b'' if status == 204 else json.dumps(body, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('Request error',))[0]})

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def dispatch(self):
        try:
            if self.headers.get('Transfer-Encoding') is not None:
                self.send_error(400, 'Transfer-Encoding is unsupported')
                return
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
                self.send_error(400, 'Invalid Content-Length')
                return
            length = int(lengths[0]) if lengths else 0
            if length > MAX_BODY:
                self.send_error(413, 'Request body exceeds 1 MiB')
                self.wfile.flush()
                # Allow a client still uploading to receive the rejection before
                # closing, without buffering the body or waiting indefinitely.
                deadline = time.monotonic() + 2
                remaining = length
                while remaining:
                    timeout = deadline - time.monotonic()
                    if timeout <= 0:
                        break
                    self.connection.settimeout(timeout)
                    try:
                        chunk = self.rfile.read1(min(65536, remaining))
                    except OSError:
                        break
                    if not chunk:
                        break
                    remaining -= len(chunk)
                return
            if self.command not in ('GET', 'PUT', 'DELETE'):
                self.send_error(405, 'Unsupported method')
                return
            path = urlsplit(self.path).path
            if path in ('/health', '/v1/keys'):
                if self.command != 'GET':
                    self.send_error(405, 'Unsupported method')
                elif path == '/health':
                    self.send_json(200, {'status': 'ok'})
                else:
                    self.send_json(*self.server.store.request('keys'))
                return
            if not path.startswith('/v1/kv/'):
                self.send_error(404, 'Unknown route')
                return
            encoded = path[len('/v1/kv/'):]
            if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
                raise ValueError('Invalid key encoding')
            key = unquote_to_bytes(encoded).decode('utf-8', errors='strict')
            if not key or '/' in key:
                raise ValueError('Key must be nonempty and contain no slash')
            value, ttl = None, None
            if self.command == 'PUT':
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError('Incomplete request body')
                obj = parse_json(body.decode('utf-8'))
                if not isinstance(obj, dict) or 'value' not in obj or set(obj) - {'value', 'ttl_seconds'}:
                    raise ValueError('Expected value and optional ttl_seconds')
                value = obj['value']
                if 'ttl_seconds' in obj:
                    ttl = obj['ttl_seconds']
                    if type(ttl) not in (float, int) or not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
                        raise ValueError('TTL must be finite and positive')
            self.send_json(*self.server.store.request(self.command, key, value, ttl))
        except (ValueError, UnicodeError, OverflowError, RecursionError) as exc:
            self.send_error(400, str(exc))
        except TimeoutError:
            self.send_error(408, 'Request timed out')
        except OSError as exc:
            self.log_error('I/O failure: %s', exc)
            self.send_error(500, 'Storage or connection failure')

    do_GET = do_PUT = do_DELETE = do_POST = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT = dispatch

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.dispatch
        raise AttributeError(name)


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
    except (OSError, ValueError) as exc:
        print(f'Startup failed: {exc}', file=sys.stderr)
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
