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
    raise ValueError(f"Invalid JSON number: {value}")


def decode_json(data):
    return json.loads(data.decode('utf-8'), parse_constant=reject_constant)


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8')


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            data = decode_json(self.path.read_bytes())
            if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('entries'), dict):
                raise ValueError('Invalid persistence file')
            for key, entry in data['entries'].items():
                if not valid_key(key) or not isinstance(entry, dict) or set(entry) != {'value', 'expires_at'}:
                    raise ValueError('Invalid persisted entry')
                expiry = entry['expires_at']
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('Invalid persisted expiry')
            encode_json(data)  # Also reject overflowed JSON numbers.
            self.entries = self.live(data['entries'])
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.persist(self.entries)

    @staticmethod
    def live(entries):
        now = time.time()
        return {k: v for k, v in entries.items() if v['expires_at'] is None or v['expires_at'] > now}

    def persist(self, entries):
        payload = encode_json({'version': 1, 'entries': entries})
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=self.path.name + '.', suffix='.tmp', delete=False) as stream:
                name = stream.name
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live(self.entries)
            present = key in entries
            if method == 'PUT':
                entries[key] = {'value': value, 'expires_at': None if ttl is None else time.time() + ttl}
                result = (200 if present else 201, {'key': key, 'value': value})
            elif method == 'DELETE':
                if present:
                    del entries[key]
                result = (204, None) if present else (404, {'error': 'Key not found'})
            elif method == 'GET':
                result = (200, {'key': key, 'value': entries[key]['value']}) if present else (404, {'error': 'Key not found'})
            else:
                result = (200, {'keys': sorted(entries)})
            if method == 'PUT' or entries != self.entries:
                self.persist(entries)
                self.entries = entries
            return result


def valid_key(key):
    if not isinstance(key, str) or not key or '/' in key:
        return False
    try:
        key.encode('utf-8', errors='strict')
    except UnicodeError:
        return False
    return True


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also makes rejected/oversized bodies safe to discard.
    protocol_version = 'HTTP/1.0'

    def send_json(self, status, body):
        payload = b'' if body is None else encode_json(body)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        if code == 501:
            code, message = 405, 'Method not allowed'
        self.send_json(code, {'error': message or self.responses.get(code, ('Error',))[0]})

    def handle_request(self):
        try:
            self.dispatch()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.log_error('Request failed: %s', exc)
            self.send_json(500, {'error': 'Internal server error'})

    def dispatch(self):
        if self.headers.get('Transfer-Encoding') is not None:
            self.send_error(400, 'Transfer-Encoding is not supported')
            return
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
            self.send_error(400, 'Invalid Content-Length')
            return
        if lengths and (len(lengths[0]) > 10 or int(lengths[0]) > MAX_BODY):
            self.send_error(413, 'Request body exceeds 1 MiB')
            return
        length = int(lengths[0]) if lengths else 0
        try:
            path = urlsplit(self.path).path
        except ValueError:
            self.send_error(400, 'Invalid request target')
            return
        key = None
        if path.startswith('/v1/kv/'):
            raw = path[len('/v1/kv/'):]
            try:
                if re.search(r'%(?![0-9a-fA-F]{2})', raw):
                    raise ValueError('Malformed percent escape')
                key = unquote_to_bytes(raw).decode('utf-8', errors='strict')
                if not valid_key(key):
                    raise ValueError('Invalid key')
            except (ValueError, UnicodeError):
                self.send_error(400, 'Invalid key')
                return
            allowed = {'GET', 'PUT', 'DELETE'}
        elif path in ('/health', '/v1/keys'):
            allowed = {'GET'}
        else:
            self.send_error(404, 'Unknown route')
            return
        if self.command not in allowed:
            self.send_error(405, 'Method not allowed')
            return
        if self.command == 'PUT' and not lengths:
            self.send_error(411, 'Content-Length is required')
            return
        body = None
        if length:
            try:
                raw_body = self.rfile.read(length)
                if len(raw_body) != length:
                    raise ValueError('Incomplete body')
                body = decode_json(raw_body)
                encode_json(body)
            except (ValueError, UnicodeError, RecursionError):
                self.send_error(400, 'Invalid JSON body')
                return
        if self.command == 'PUT':
            if not isinstance(body, dict) or 'value' not in body or not set(body) <= {'value', 'ttl_seconds'}:
                self.send_error(400, 'Expected value and optional ttl_seconds')
                return
            ttl = body.get('ttl_seconds')
            if 'ttl_seconds' in body:
                try:
                    valid = type(ttl) in (int, float) and math.isfinite(ttl) and ttl > 0 and math.isfinite(time.time() + ttl)
                except OverflowError:
                    valid = False
                if not valid:
                    self.send_error(400, 'TTL must be a finite positive number')
                    return
            status, result = self.server.store.operate('PUT', key, body['value'], ttl)
        elif path == '/health':
            status, result = 200, {'status': 'ok'}
        else:
            status, result = self.server.store.operate('KEYS' if path == '/v1/keys' else self.command, key)
        self.send_json(status, result)

    do_GET = do_PUT = do_DELETE = do_POST = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT = handle_request

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
    print(f'LISTENING {server.server_address[1]}', flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
