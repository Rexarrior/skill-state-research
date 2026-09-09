#!/usr/bin/env python3
"""Persistent, dependency-free HTTP key-value service."""
import argparse
import json
import math
import os
import re
import signal
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

MAX_BODY = 1024 * 1024


def reject_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def decode_json(data):
    return json.loads(data, parse_constant=reject_constant)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            document = decode_json(self.path.read_text(encoding='utf-8'))
            if not isinstance(document, dict) or document.get('version') != 1 or not isinstance(document.get('entries'), dict):
                raise ValueError('Invalid persistence file')
            for key, entry in document['entries'].items():
                if not key or '/' in key or not isinstance(entry, dict) or 'value' not in entry or 'expires_at' not in entry:
                    raise ValueError('Invalid persisted entry')
                expiry = entry['expires_at']
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('Invalid persisted expiration')
            self.entries = document['entries']
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.entries = self.live()
        self.persist(self.entries)

    def live(self):
        now = time.time()
        return {key: entry for key, entry in self.entries.items()
                if entry['expires_at'] is None or entry['expires_at'] > now}

    def persist(self, entries):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent,
                                             prefix=f'.{self.path.name}.', delete=False) as file:
                temporary = file.name
                json.dump({'version': 1, 'entries': entries}, file, ensure_ascii=True, allow_nan=False)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            if method == 'PUT':
                status = 200 if key in entries else 201
                entries[key] = {'value': value, 'expires_at': None if ttl is None else time.time() + ttl}
                result = {'key': key, 'value': value}
            elif method == 'DELETE':
                status = 204 if key in entries else 404
                entries.pop(key, None)
                result = None
            elif method == 'GET':
                status = 200 if key in entries else 404
                result = {'key': key, 'value': entries[key]['value']} if status == 200 else None
            else:
                status, result = 200, {'keys': sorted(entries)}
            if entries != self.entries:
                self.persist(entries)
                self.entries = entries
            return status, result


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also prevents unread malformed bodies from being reused.
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def send_json(self, status, body):
        data = b'' if status == 204 else json.dumps(body, ensure_ascii=True, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('Error',))[0]})

    def __getattr__(self, name):
        if name.startswith('do_'):
            return lambda: self.send_error(405, 'Unsupported method')
        raise AttributeError(name)

    def route(self):
        path = urlsplit(self.path).path
        if path in ('/health', '/v1/keys'):
            return path, None
        if not path.startswith('/v1/kv/'):
            return None, None
        encoded = path[len('/v1/kv/'):]
        if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
            raise ValueError('Invalid key encoding')
        key = unquote(encoded, encoding='utf-8', errors='strict')
        if not key or '/' in key:
            raise ValueError('Invalid key')
        return '/v1/kv', key

    def handle_api(self):
        try:
            if self.headers.get('Transfer-Encoding') is not None:
                self.send_error(400, 'Transfer-Encoding is unsupported')
                return
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
                raise ValueError('Invalid Content-Length')
            length = int(lengths[0]) if lengths else 0
            if length > MAX_BODY:
                self.send_error(413, 'Request body exceeds 1 MiB')
                return
            route, key = self.route()
            if route is None:
                self.send_error(404, 'Unknown route')
                return
            if route in ('/health', '/v1/keys') and self.command != 'GET':
                self.send_error(405, 'Unsupported method')
                return
            if route == '/health':
                self.send_json(200, {'status': 'ok'})
                return
            if self.command == 'PUT':
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('Incomplete request body')
                payload = decode_json(raw.decode('utf-8'))
                if not isinstance(payload, dict) or 'value' not in payload:
                    raise ValueError('Body must be an object containing value')
                ttl = payload.get('ttl_seconds')
                if 'ttl_seconds' in payload:
                    if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
                        raise ValueError('ttl_seconds must be finite and greater than zero')
                # Reject overflowing JSON floats inside arbitrary values as well.
                json.dumps(payload['value'], allow_nan=False)
                status, body = self.server.store.operate('PUT', key, payload['value'], ttl)
            else:
                status, body = self.server.store.operate('LIST' if route == '/v1/keys' else self.command, key)
            if status == 404:
                body = {'error': 'Key not found'}
            self.send_json(status, body)
        except (ValueError, UnicodeError, OverflowError, RecursionError) as error:
            self.send_error(400, str(error))
        except TimeoutError:
            self.send_error(408, 'Request timed out')
        except OSError as error:
            print(f'Request failed: {error}', file=sys.stderr, flush=True)
            self.send_error(500, 'Storage or connection error')

    do_GET = handle_api
    do_PUT = handle_api
    do_DELETE = handle_api


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
        with Server((args.host, args.port), Handler) as server:
            server.store = store
            def stop(signum, frame):
                threading.Thread(target=server.shutdown, daemon=True).start()
            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            print(f'LISTENING {server.server_port}', flush=True)
            server.serve_forever(poll_interval=0.1)
        return 0
    except (OSError, ValueError) as error:
        print(f'Startup failed: {error}', file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
