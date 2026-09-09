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


def decode_json(data):
    return json.loads(data.decode('utf-8'), parse_constant=reject_constant)


def valid_key(key):
    if not isinstance(key, str) or not key or '/' in key:
        return False
    try:
        key.encode('utf-8')
        return True
    except UnicodeError:
        return False


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
            self.entries = document['entries']
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.save(self.live())
        self.entries = self.live()

    def live(self):
        now = time.time()
        return {k: v for k, v in self.entries.items() if v['expires_at'] is None or v['expires_at'] > now}

    def save(self, entries):
        data = json.dumps({'version': 1, 'entries': entries}, ensure_ascii=True, allow_nan=False).encode('utf-8')
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=f'.{self.path.name}.', delete=False) as handle:
                name = handle.name
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(name, self.path)
            name = None
        finally:
            if name is not None:
                os.unlink(name)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            present = key in entries
            if method == 'PUT':
                entries[key] = {'value': value, 'expires_at': None if ttl is None else time.time() + ttl}
                self.save(entries)
                self.entries = entries
                return (200 if present else 201), {'key': key, 'value': value}
            if method == 'DELETE' and present:
                del entries[key]
            if entries != self.entries:
                self.save(entries)
                self.entries = entries
            if method == 'KEYS':
                return 200, {'keys': sorted(entries)}
            if not present:
                return 404, {'error': 'Key not found'}
            if method == 'DELETE':
                return 204, None
            return 200, {'key': key, 'value': entries[key]['value']}


class Handler(BaseHTTPRequestHandler):
    # Close each connection so rejected or unread request bodies cannot be reused.
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def send_json(self, status, body):
        payload = b'' if body is None else json.dumps(body, ensure_ascii=True, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('Request error',))[0]})

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.dispatch
        raise AttributeError(name)

    def dispatch(self):
        try:
            self.handle_api()
        except (TimeoutError, ConnectionError):
            self.close_connection = True
        except (OSError, ValueError, OverflowError, RecursionError) as exc:
            print(f'Request failed: {exc}', file=sys.stderr)
            self.send_error(500, 'Internal server error')

    def handle_api(self):
        if self.headers.get('Transfer-Encoding') is not None:
            self.send_error(400, 'Transfer-Encoding is not supported')
            return
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
            self.send_error(400, 'Invalid Content-Length')
            return
        normalized_length = lengths[0].lstrip('0') or '0' if lengths else '0'
        if len(normalized_length) > 7 or int(normalized_length) > MAX_BODY:
            self.send_error(413, 'Request body exceeds 1 MiB')
            return
        length = int(normalized_length)
        try:
            path = urlsplit(self.path).path
        except ValueError:
            self.send_error(400, 'Invalid URL')
            return
        key = None
        if path.startswith('/v1/kv/'):
            raw_key = path[len('/v1/kv/'):]
            try:
                if re.search(r'%(?![0-9a-fA-F]{2})', raw_key):
                    raise ValueError('Invalid percent encoding')
                key = unquote_to_bytes(raw_key).decode('utf-8')
                if not valid_key(key):
                    raise ValueError('Invalid key')
            except (ValueError, UnicodeError):
                self.send_error(400, 'Invalid key')
                return
            allowed = {'PUT', 'GET', 'DELETE'}
        elif path in ('/health', '/v1/keys'):
            allowed = {'GET'}
        else:
            self.send_error(404, 'Unknown route')
            return
        if self.command not in allowed:
            self.send_error(405, 'Method not allowed')
            return
        body = None
        if length:
            data = self.rfile.read(length)
            try:
                if len(data) != length:
                    raise ValueError('Incomplete body')
                body = decode_json(data)
                # Reject nonfinite values produced by numeric overflow as well.
                json.dumps(body, allow_nan=False)
            except (ValueError, UnicodeError, RecursionError, OverflowError):
                self.send_error(400, 'Malformed JSON')
                return
        if self.command == 'PUT':
            if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
                self.send_error(400, 'Expected value and optional ttl_seconds')
                return
            ttl = body.get('ttl_seconds')
            if 'ttl_seconds' in body:
                try:
                    if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
                        raise ValueError('Invalid TTL')
                except (ValueError, OverflowError):
                    self.send_error(400, 'TTL must be finite and greater than zero')
                    return
            status, result = self.server.store.operate('PUT', key, body['value'], ttl)
        elif path == '/health':
            status, result = 200, {'status': 'ok'}
        else:
            status, result = self.server.store.operate('KEYS' if path == '/v1/keys' else self.command, key)
        self.send_json(status, result)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--data', required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
    except (OSError, ValueError, OverflowError, RecursionError) as exc:
        print(f'Cannot start server: {exc}', file=sys.stderr)
        return 1
    server.store = store
    stopping = threading.Event()

    def stop(signum, frame):
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f'LISTENING {server.server_address[1]}', flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        with store.lock:
            store.save(store.live())
    return 0


if __name__ == '__main__':
    sys.exit(main())
