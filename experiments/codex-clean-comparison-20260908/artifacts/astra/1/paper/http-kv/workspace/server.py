#!/usr/bin/env python3
"""Persistent, dependency-free HTTP key-value service."""
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
    raise ValueError(f'Invalid JSON constant: {value}')


def decode_json(data):
    return json.loads(data, parse_constant=reject_constant)


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
            records = decode_json(self.path.read_text(encoding='utf-8'))
            if not isinstance(records, dict):
                raise ValueError('Invalid persisted state')
            for key, record in records.items():
                if not valid_key(key) or not isinstance(record, dict) or set(record) != {'value', 'expires_at'}:
                    raise ValueError('Invalid persisted entry')
                expiry = record['expires_at']
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('Invalid persisted expiry')
            self.entries = records
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Also remove expired records left by a stopped process.
        self.persist(self.live())

    def live(self):
        now = time.time()
        return {k: v for k, v in self.entries.items()
                if v['expires_at'] is None or v['expires_at'] > now}

    def persist(self, entries):
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent,
                                             prefix=f'.{self.path.name}.', delete=False) as stream:
                temp = stream.name
                json.dump(entries, stream, ensure_ascii=True, allow_nan=False, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self.path)
        finally:
            if temp is not None and os.path.exists(temp):
                os.unlink(temp)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            present = key in entries
            if method == 'PUT':
                entries[key] = {'value': value, 'expires_at': None if ttl is None else time.time() + ttl}
                status, body = (200 if present else 201), {'key': key, 'value': value}
            elif method == 'DELETE':
                if present:
                    del entries[key]
                status, body = (204, None) if present else (404, {'error': 'Key not found'})
            elif method == 'GET':
                status, body = (200, {'key': key, 'value': entries[key]['value']}) if present else (404, {'error': 'Key not found'})
            else:
                status, body = 200, {'keys': sorted(entries)}
            if entries != self.entries:
                self.persist(entries)
                self.entries = entries
            return status, body


class Handler(BaseHTTPRequestHandler):
    # One request per connection also prevents rejected bodies from being reused.
    protocol_version = 'HTTP/1.0'

    def send_json(self, status, body):
        payload = b'' if body is None else json.dumps(body, ensure_ascii=True, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('Error',))[0]})

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.handle_api
        raise AttributeError(name)

    def handle_api(self):
        try:
            self.dispatch()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.log_error('Request failed: %s', exc)
            self.send_json(500, {'error': 'Internal server error'})

    def dispatch(self):
        if self.headers.get('Transfer-Encoding') is not None:
            self.send_json(400, {'error': 'Transfer-Encoding is not supported'})
            return
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
            self.send_json(400, {'error': 'Invalid Content-Length'})
            return
        try:
            length = int(lengths[0]) if lengths else 0
        except ValueError:
            length = MAX_BODY + 1
        if length > MAX_BODY:
            self.send_json(413, {'error': 'Request body exceeds 1 MiB'})
            return
        try:
            path = urlsplit(self.path).path
        except ValueError:
            self.send_json(400, {'error': 'Invalid URL'})
            return
        key = None
        if path.startswith('/v1/kv/'):
            encoded = path[len('/v1/kv/'):]
            try:
                if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
                    raise ValueError('Invalid percent encoding')
                key = unquote(encoded, encoding='utf-8', errors='strict')
                if not valid_key(key):
                    raise ValueError('Invalid key')
            except (ValueError, UnicodeError):
                self.send_json(400, {'error': 'Invalid key'})
                return
            allowed = {'PUT', 'GET', 'DELETE'}
        elif path in ('/v1/keys', '/health'):
            allowed = {'GET'}
        else:
            self.send_json(404, {'error': 'Unknown route'})
            return
        if self.command not in allowed:
            self.send_json(405, {'error': 'Method not allowed'})
            return
        value, ttl = None, None
        if self.command == 'PUT':
            try:
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('Incomplete body')
                body = decode_json(raw.decode('utf-8'))
                if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
                    raise ValueError('Expected value and optional ttl_seconds')
                value = body['value']
                # Reject overflowed JSON numbers, including nested values.
                json.dumps(value, allow_nan=False)
                if 'ttl_seconds' in body:
                    ttl = body['ttl_seconds']
                    if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
                        raise ValueError('TTL must be finite and positive')
            except (ValueError, UnicodeError, OverflowError, RecursionError):
                self.send_json(400, {'error': 'Invalid JSON body or TTL'})
                return
        if path == '/health':
            self.send_json(200, {'status': 'ok'})
        else:
            operation = 'KEYS' if path == '/v1/keys' else self.command
            self.send_json(*self.server.store.operate(operation, key, value, ttl))


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--data', required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
        server.store = store
    except (OSError, ValueError, OverflowError) as exc:
        print(f'Startup failed: {exc}', file=sys.stderr)
        return 1

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
