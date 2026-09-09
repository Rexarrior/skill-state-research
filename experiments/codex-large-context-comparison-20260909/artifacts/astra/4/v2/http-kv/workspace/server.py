#!/usr/bin/env python3
"""A small persistent, thread-safe HTTP key-value service."""
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


def decode_json(raw):
    return json.loads(raw.decode('utf-8'), parse_constant=reject_constant)


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8')


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
            document = decode_json(self.path.read_bytes())
            if not isinstance(document, dict) or document.get('version') != 1 or not isinstance(document.get('entries'), dict):
                raise ValueError('Invalid persistence file')
            for key, entry in document['entries'].items():
                if not valid_key(key) or not isinstance(entry, dict) or set(entry) != {'value', 'expires_at'}:
                    raise ValueError('Invalid persisted entry')
                expiry = entry['expires_at']
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('Invalid persisted expiry')
            encode_json(document)  # Reject non-finite numbers at any depth.
            self.entries = document['entries']
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.entries = self.live()
        self.persist(self.entries)

    def live(self):
        now = time.time()
        return {key: entry for key, entry in self.entries.items()
                if entry['expires_at'] is None or entry['expires_at'] > now}

    def persist(self, entries):
        payload = encode_json({'version': 1, 'entries': entries})
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix='.' + self.path.name + '.', delete=False) as file:
                name = file.name
                file.write(payload)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)

    def execute(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            if method == 'keys':
                return 200, {'keys': sorted(entries)}
            if method == 'GET':
                if key not in entries:
                    return 404, {'error': 'Key not found'}
                return 200, {'key': key, 'value': entries[key]['value']}
            if method == 'DELETE':
                if key not in entries:
                    return 404, {'error': 'Key not found'}
                del entries[key]
                status, body = 204, None
            else:
                status = 200 if key in entries else 201
                expiry = None if ttl is None else time.time() + ttl
                if expiry is not None and not math.isfinite(expiry):
                    return 400, {'error': 'TTL is too large'}
                entries[key] = {'value': value, 'expires_at': expiry}
                body = {'key': key, 'value': value}
            self.persist(entries)
            self.entries = entries
            return status, body

    def close(self):
        with self.lock:
            entries = self.live()
            self.persist(entries)
            self.entries = entries


class Handler(BaseHTTPRequestHandler):
    # Close each connection, including rejected requests with unread bodies.
    protocol_version = 'HTTP/1.0'

    def send_json(self, status, body):
        payload = b'' if status == 204 else encode_json(body)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('HTTP error',))[0]})

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.handle_api
        raise AttributeError(name)

    def handle_api(self):
        try:
            self.route()
        except (ValueError, UnicodeError, OverflowError, RecursionError) as exc:
            self.send_json(400, {'error': 'Invalid request: ' + str(exc)[:200]})
        except (TimeoutError, ConnectionError):
            self.close_connection = True
        except OSError as exc:
            print(f'Persistence/request error: {exc}', file=sys.stderr, flush=True)
            self.send_json(500, {'error': 'Storage failure'})

    def route(self):
        if self.headers.get('Transfer-Encoding') is not None:
            self.send_json(400, {'error': 'Transfer-Encoding is not supported'})
            return
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
            raise ValueError('Invalid Content-Length')
        length = int(lengths[0]) if lengths else 0
        if length > MAX_BODY:
            self.send_json(413, {'error': 'Request body exceeds 1 MiB'})
            return
        path = urlsplit(self.path).path
        if path == '/health':
            allowed, key = ('GET',), None
        elif path == '/v1/keys':
            allowed, key = ('GET',), None
        elif path.startswith('/v1/kv/'):
            encoded = path[len('/v1/kv/'):]
            if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
                raise ValueError('Malformed key encoding')
            key = unquote_to_bytes(encoded).decode('utf-8')
            if not valid_key(key):
                raise ValueError('Invalid key')
            allowed = ('GET', 'PUT', 'DELETE')
        else:
            self.send_json(404, {'error': 'Unknown route'})
            return
        if self.command not in allowed:
            self.send_json(405, {'error': 'Method not allowed'})
            return
        value, ttl = None, None
        if self.command == 'PUT':
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('Incomplete body')
            body = decode_json(raw)
            if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
                raise ValueError('Expected value and optional ttl_seconds')
            encode_json(body)
            value = body['value']
            if 'ttl_seconds' in body:
                ttl = body['ttl_seconds']
                if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0:
                    raise ValueError('TTL must be finite and greater than zero')
        if path == '/health':
            self.send_json(200, {'status': 'ok'})
        else:
            status, body = self.server.store.execute('keys' if path == '/v1/keys' else self.command, key, value, ttl)
            self.send_json(status, body)

    def setup(self):
        super().setup()
        self.connection.settimeout(10)


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
        store.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
