#!/usr/bin/env python3
"""A small, durable HTTP JSON key-value service."""
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
            with self.path.open(encoding='utf-8') as stream:
                data = json.load(stream, parse_constant=reject_constant)
            if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('entries'), dict):
                raise ValueError('Invalid persistence file')
            for key, entry in data['entries'].items():
                if not valid_key(key) or not isinstance(entry, dict) or set(entry) != {'value', 'expires_at'}:
                    raise ValueError('Invalid persisted entry')
                expiry = entry['expires_at']
                if expiry is not None and (isinstance(expiry, bool) or not isinstance(expiry, (int, float)) or not math.isfinite(expiry)):
                    raise ValueError('Invalid persisted expiration')
            self.entries = self.live(data['entries'])
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.persist(self.entries)

    @staticmethod
    def live(entries):
        now = time.time()
        return {k: v for k, v in entries.items() if v['expires_at'] is None or v['expires_at'] > now}

    def persist(self, entries):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent, prefix=f'.{self.path.name}.', delete=False) as stream:
                temporary = stream.name
                json.dump({'version': 1, 'entries': entries}, stream, ensure_ascii=True, allow_nan=False, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            current = self.live(self.entries)
            present = key in current
            if method == 'PUT':
                current[key] = {'value': value, 'expires_at': None if ttl is None else time.time() + ttl}
                result = (200 if present else 201, {'key': key, 'value': value})
            elif method == 'DELETE':
                if present:
                    del current[key]
                result = (204, None) if present else (404, {'error': 'Key not found'})
            elif key is None:
                result = (200, {'keys': sorted(current)})
            else:
                result = (200, {'key': key, 'value': current[key]['value']}) if present else (404, {'error': 'Key not found'})
            if method in ('PUT', 'DELETE') or current != self.entries:
                self.persist(current)
                self.entries = current
            return result


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also prevents unread invalid bodies being reused.
    protocol_version = 'HTTP/1.0'

    def send_json(self, status, payload):
        body = b'' if status == 204 else json.dumps(payload, ensure_ascii=True, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('Request error',))[0]})

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.unsupported
        raise AttributeError(name)

    def unsupported(self):
        self.send_json(405, {'error': 'Method not allowed'})

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def dispatch(self):
        try:
            if self.headers.get('Transfer-Encoding') is not None:
                self.send_json(400, {'error': 'Transfer-Encoding is not supported'})
                return
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
                self.send_json(400, {'error': 'Invalid Content-Length'})
                return
            length = int(lengths[0]) if lengths else 0
            if length > MAX_BODY:
                self.send_json(413, {'error': 'Request body exceeds 1 MiB'})
                return
            path = urlsplit(self.path).path
            if path in ('/health', '/v1/keys'):
                if self.command != 'GET':
                    self.unsupported()
                elif path == '/health':
                    self.send_json(200, {'status': 'ok'})
                else:
                    self.send_json(*self.server.store.operate('GET'))
                return
            if not path.startswith('/v1/kv/'):
                self.send_json(404, {'error': 'Unknown route'})
                return
            encoded = path[len('/v1/kv/'):]
            if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
                raise ValueError('Invalid key encoding')
            key = unquote(encoded, encoding='utf-8', errors='strict')
            if not valid_key(key):
                raise ValueError('Invalid key')
            value, ttl = None, None
            if self.command == 'PUT':
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('Incomplete request body')
                data = json.loads(raw.decode('utf-8'), parse_constant=reject_constant)
                if not isinstance(data, dict) or 'value' not in data or set(data) - {'value', 'ttl_seconds'}:
                    raise ValueError('Expected value and optional ttl_seconds')
                value = data['value']
                if 'ttl_seconds' in data:
                    ttl = data['ttl_seconds']
                    if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
                        raise ValueError('TTL must be finite and greater than zero')
                # Also rejects nonfinite floats produced by overflowing JSON exponents.
                json.dumps(value, allow_nan=False)
            self.send_json(*self.server.store.operate(self.command, key, value, ttl))
        except (ValueError, UnicodeError, OverflowError, RecursionError) as exc:
            self.send_json(400, {'error': str(exc)})
        except TimeoutError:
            self.send_json(408, {'error': 'Request timed out'})
        except OSError as exc:
            print(f'Request failed: {exc}', file=sys.stderr)
            self.send_json(500, {'error': 'Storage or connection failure'})

    do_GET = dispatch
    do_PUT = dispatch
    do_DELETE = dispatch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--data', required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except (OSError, ValueError) as exc:
        print(f'Startup failed: {exc}', file=sys.stderr)
        return 1
    server.store = store
    server.daemon_threads = False
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
