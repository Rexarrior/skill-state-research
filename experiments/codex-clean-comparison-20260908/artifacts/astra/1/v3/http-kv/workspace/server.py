#!/usr/bin/env python3
"""A dependency-free persistent HTTP key-value service."""
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
    def reject_constant(value):
        raise ValueError(f'invalid JSON constant: {value}')

    def finite_float(value):
        result = float(value)
        if not math.isfinite(result):
            raise ValueError('number is not finite')
        return result

    return json.loads(data, parse_constant=reject_constant, parse_float=finite_float)


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
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            data = strict_json(self.path.read_text(encoding='utf-8'))
            if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('entries'), dict):
                raise ValueError('invalid persistence file')
            for key, entry in data['entries'].items():
                if not valid_key(key) or not isinstance(entry, dict) or set(entry) != {'value', 'expires_at'}:
                    raise ValueError('invalid persisted entry')
                expiry = entry['expires_at']
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('invalid persisted expiration')
            self.entries = data['entries']
        # Remove expired records on startup as well as on each operation.
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
                                             prefix=f'.{self.path.name}.', delete=False) as stream:
                temporary = stream.name
                json.dump({'version': 1, 'entries': entries}, stream, allow_nan=False,
                          ensure_ascii=True, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            present = key in entries
            if method == 'PUT':
                expires_at = None if ttl is None else time.time() + ttl
                entries[key] = {'value': value, 'expires_at': expires_at}
                result = (200 if present else 201, {'key': key, 'value': value})
            elif method == 'DELETE':
                if present:
                    del entries[key]
                result = (204, None) if present else (404, {'error': 'key not found'})
            elif method == 'GET':
                result = (200, {'key': key, 'value': entries[key]['value']}) if present else (404, {'error': 'key not found'})
            else:
                result = (200, {'keys': sorted(entries)})
            if method == 'PUT' or (method == 'DELETE' and present) or len(entries) != len(self.entries):
                # Publish in memory only after the new snapshot is safely written.
                self.persist(entries)
                self.entries = entries
            return result


class Handler(BaseHTTPRequestHandler):
    # A connection handles one request: rejected/unread bodies cannot become requests.
    protocol_version = 'HTTP/1.0'

    def send_json(self, status, body, headers=None):
        encoded = b'' if body is None else json.dumps(body, ensure_ascii=True, allow_nan=False,
                                                     separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(encoded)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('request error',))[0]})

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.handle_api
        raise AttributeError(name)

    def handle_api(self):
        try:
            self.dispatch()
        except (OSError, ValueError, OverflowError, RecursionError) as exc:
            self.log_error('request failed: %s', exc)
            try:
                self.send_json(500, {'error': 'internal server error'})
            except OSError:
                pass

    def dispatch(self):
        lengths = self.headers.get_all('Content-Length', [])
        if self.headers.get('Transfer-Encoding') is not None:
            return self.send_json(400, {'error': 'transfer encoding is unsupported'})
        if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
            return self.send_json(400, {'error': 'invalid Content-Length'})
        if lengths and len(lengths[0].lstrip('0')) > 7:
            return self.send_json(413, {'error': 'request body exceeds 1 MiB'})
        length = int(lengths[0]) if lengths else 0
        if length > MAX_BODY:
            return self.send_json(413, {'error': 'request body exceeds 1 MiB'})
        try:
            path = urlsplit(self.path).path
        except ValueError:
            return self.send_json(400, {'error': 'invalid URL'})
        key = None
        if path in ('/health', '/v1/keys'):
            allowed = ('GET',)
        elif path.startswith('/v1/kv/'):
            encoded = path[len('/v1/kv/'):]
            try:
                if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
                    raise ValueError('invalid percent escape')
                key = unquote_to_bytes(encoded).decode('utf-8', errors='strict')
                if not valid_key(key):
                    raise ValueError('invalid key')
            except (UnicodeError, ValueError):
                return self.send_json(400, {'error': 'invalid key'})
            allowed = ('GET', 'PUT', 'DELETE')
        else:
            return self.send_json(404, {'error': 'route not found'})
        if self.command not in allowed:
            return self.send_json(405, {'error': 'method not allowed'}, {'Allow': ', '.join(allowed)})
        body = None
        if length:
            try:
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('incomplete body')
                body = strict_json(raw.decode('utf-8'))
            except (UnicodeError, ValueError, RecursionError):
                return self.send_json(400, {'error': 'malformed JSON body'})
        if self.command == 'PUT':
            if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
                return self.send_json(400, {'error': 'expected value and optional ttl_seconds'})
            ttl = body.get('ttl_seconds')
            if 'ttl_seconds' in body:
                try:
                    valid = type(ttl) in (int, float) and math.isfinite(ttl) and ttl > 0 and math.isfinite(time.time() + ttl)
                except OverflowError:
                    valid = False
                if not valid:
                    return self.send_json(400, {'error': 'ttl_seconds must be finite and greater than zero'})
            status, response = self.server.store.operate('PUT', key, body['value'], ttl)
        elif path == '/health':
            status, response = 200, {'status': 'ok'}
        else:
            status, response = self.server.store.operate('LIST' if path == '/v1/keys' else self.command, key)
        self.send_json(status, response)


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
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--data', required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
    except (OSError, ValueError, OverflowError, RecursionError) as exc:
        print(f'Unable to start: {exc}', file=sys.stderr)
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
