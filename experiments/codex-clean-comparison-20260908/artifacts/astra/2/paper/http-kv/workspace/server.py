#!/usr/bin/env python3
"""Persistent, standard-library HTTP key-value service."""
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
    raise ValueError(f'Invalid JSON constant: {value}')


def decode_json(data):
    return json.loads(data, parse_constant=reject_constant)


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8')


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            saved = decode_json(self.path.read_text(encoding='utf-8'))
            if not isinstance(saved, dict) or saved.get('version') != 1 or not isinstance(saved.get('entries'), dict):
                raise ValueError('Invalid data file')
            now = time.time()
            for key, entry in saved['entries'].items():
                if not key or '/' in key or not isinstance(entry, dict) or 'value' not in entry:
                    raise ValueError('Invalid persisted entry')
                key.encode('utf-8')
                expiry = entry.get('expires_at')
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('Invalid persisted expiration')
                encode_json(entry['value'])
                if expiry is None or expiry > now:
                    self.entries[key] = entry

    def live(self):
        now = time.time()
        return {key: entry for key, entry in self.entries.items()
                if entry['expires_at'] is None or entry['expires_at'] > now}

    def commit(self, entries):
        payload = encode_json({'version': 1, 'entries': entries})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=f'.{self.path.name}.', delete=False) as stream:
                name = stream.name
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
            self.entries = entries
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)


class APIError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also safely discards unread/rejected request bodies.
    protocol_version = 'HTTP/1.0'

    def send_json(self, status, body=None):
        data = b'' if body is None else encode_json(body)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('Error',))[0]})

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def route(self):
        path = urlsplit(self.path).path
        if path in ('/health', '/v1/keys'):
            return path, None
        prefix = '/v1/kv/'
        if not path.startswith(prefix):
            raise APIError(404, 'Unknown route')
        raw = path[len(prefix):]
        if re.search(r'%(?![0-9a-fA-F]{2})', raw):
            raise APIError(400, 'Invalid key encoding')
        try:
            key = unquote_to_bytes(raw).decode('utf-8', errors='strict')
        except UnicodeError:
            raise APIError(400, 'Key must be UTF-8')
        if not key or '/' in key:
            raise APIError(400, 'Key must be nonempty and cannot contain /')
        return 'kv', key

    def read_body(self):
        if self.headers.get('Transfer-Encoding') is not None:
            raise APIError(400, 'Transfer-Encoding is unsupported')
        lengths = self.headers.get_all('Content-Length', [])
        if not lengths:
            raise APIError(400, 'Content-Length is required')
        if len(lengths) != 1 or not re.fullmatch(r'[0-9]+', lengths[0]):
            raise APIError(400, 'Invalid Content-Length')
        try:
            length = int(lengths[0])
        except ValueError:
            raise APIError(413, 'Body exceeds 1 MiB')
        if length > MAX_BODY:
            raise APIError(413, 'Body exceeds 1 MiB')
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise APIError(400, 'Incomplete body')
        try:
            body = decode_json(raw.decode('utf-8'))
            encode_json(body)  # Reject nonfinite numbers, including exponent overflow.
        except (ValueError, UnicodeError, RecursionError, OverflowError):
            raise APIError(400, 'Malformed JSON')
        if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
            raise APIError(400, 'Expected value and optional ttl_seconds')
        ttl = body.get('ttl_seconds')
        if 'ttl_seconds' in body:
            try:
                valid = type(ttl) in (int, float) and math.isfinite(ttl) and ttl > 0 and math.isfinite(time.time() + ttl)
            except OverflowError:
                valid = False
            if not valid:
                raise APIError(400, 'TTL must be finite and greater than zero')
        return body, ttl

    def dispatch(self):
        try:
            # Apply the size limit even to routes/methods which do not consume bodies.
            for value in self.headers.get_all('Content-Length', []):
                if re.fullmatch(r'[0-9]+', value) and (len(value.lstrip('0')) > 7 or int(value or '0') > MAX_BODY):
                    raise APIError(413, 'Body exceeds 1 MiB')
            route, key = self.route()
            allowed = ('GET', 'PUT', 'DELETE') if route == 'kv' else ('GET',)
            if self.command not in allowed:
                raise APIError(405, 'Method not allowed')
            if route == '/health':
                self.send_json(200, {'status': 'ok'})
                return
            body, ttl = self.read_body() if self.command == 'PUT' else (None, None)
            store = self.server.store
            with store.lock:
                entries = store.live()
                if route == '/v1/keys':
                    status, result = 200, {'keys': sorted(entries)}
                elif self.command == 'GET':
                    if key not in entries:
                        raise APIError(404, 'Key not found')
                    status, result = 200, {'key': key, 'value': entries[key]['value']}
                elif self.command == 'PUT':
                    status = 200 if key in entries else 201
                    entries[key] = {'value': body['value'], 'expires_at': None if ttl is None else time.time() + ttl}
                    store.commit(entries)
                    result = {'key': key, 'value': body['value']}
                else:
                    if key not in entries:
                        raise APIError(404, 'Key not found')
                    del entries[key]
                    store.commit(entries)
                    status, result = 204, None
            self.send_json(status, result)
        except APIError as exc:
            self.send_json(exc.status, {'error': exc.message})
        except (TimeoutError, ConnectionError):
            self.close_connection = True
        except Exception as exc:
            self.log_error('Request failed: %s', exc)
            self.send_json(500, {'error': 'Internal server error'})

    do_GET = do_PUT = do_DELETE = do_POST = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT = dispatch


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
    return 0


if __name__ == '__main__':
    sys.exit(main())
