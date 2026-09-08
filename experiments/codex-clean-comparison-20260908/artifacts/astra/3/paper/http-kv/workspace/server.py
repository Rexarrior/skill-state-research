#!/usr/bin/env python3
"""A small, persistent JSON key-value HTTP service (Python 3.11+)."""
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
    raise ValueError(f'Invalid JSON number: {value}')


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
            saved = decode_json(self.path.read_bytes())
            if not isinstance(saved, dict) or saved.get('version') != 1 or not isinstance(saved.get('entries'), dict):
                raise ValueError('Invalid persistence file')
            for key, entry in saved['entries'].items():
                if not key or '/' in key or not isinstance(entry, dict) or set(entry) != {'value', 'expires_at'}:
                    raise ValueError('Invalid persisted entry')
                key.encode('utf-8')
                expiry = entry['expires_at']
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('Invalid persisted expiry')
            encode_json(saved)
            self.entries = self.live(saved['entries'])

    @staticmethod
    def live(entries):
        now = time.time()
        return {k: v for k, v in entries.items() if v['expires_at'] is None or v['expires_at'] > now}

    def commit(self, entries):
        """Called with the lock held; publish memory only after durable replacement."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = encode_json({'version': 1, 'entries': entries})
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix='.' + self.path.name + '.', delete=False) as out:
                temporary = out.name
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, self.path)
            temporary = None
            self.entries = entries
        finally:
            if temporary is not None:
                os.unlink(temporary)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also prevents unread invalid bodies from being reused.
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def reply(self, status, body=None):
        data = b'' if status == 204 else encode_json(body)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {'error': message or self.responses.get(code, ('Request failed',))[0]})

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.dispatch
        raise AttributeError(name)

    def body(self):
        if self.headers.get('Transfer-Encoding') is not None:
            raise RequestError(400, 'Transfer-Encoding is not supported')
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
            raise RequestError(400, 'Invalid Content-Length')
        if lengths and (len(lengths[0].lstrip('0')) > 7 or int(lengths[0]) > MAX_BODY):
            raise RequestError(413, 'Request body exceeds 1 MiB')
        length = int(lengths[0]) if lengths else 0
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise RequestError(400, 'Incomplete request body')
        if not raw:
            return None
        try:
            return decode_json(raw.decode('utf-8'))
        except (ValueError, UnicodeError, RecursionError):
            raise RequestError(400, 'Malformed JSON')

    def route(self):
        try:
            path = urlsplit(self.path).path
        except ValueError:
            raise RequestError(400, 'Invalid URL')
        if path in ('/health', '/v1/keys'):
            return path, None
        if not path.startswith('/v1/kv/'):
            raise RequestError(404, 'Unknown route')
        encoded = path[len('/v1/kv/'):]
        try:
            if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
                raise ValueError()
            key = unquote_to_bytes(encoded).decode('utf-8', errors='strict')
            if not key or '/' in key:
                raise ValueError()
        except (ValueError, UnicodeError):
            raise RequestError(400, 'Invalid key')
        return '/v1/kv/', key

    def dispatch(self):
        try:
            body = self.body()
            route, key = self.route()
            methods = ('GET', 'PUT', 'DELETE') if key is not None else ('GET',)
            if self.command not in methods:
                raise RequestError(405, 'Unsupported method')
            if route == '/health':
                self.reply(200, {'status': 'ok'})
                return
            expiry = None
            if self.command == 'PUT':
                if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
                    raise RequestError(400, 'Expected value and optional ttl_seconds')
                if 'ttl_seconds' in body:
                    ttl = body['ttl_seconds']
                    try:
                        valid = type(ttl) in (int, float) and math.isfinite(ttl) and ttl > 0
                        expiry = time.time() + ttl if valid else None
                        valid = valid and math.isfinite(expiry)
                    except OverflowError:
                        valid = False
                    if not valid:
                        raise RequestError(400, 'TTL must be finite and greater than zero')
                try:
                    encode_json(body['value'])
                except (ValueError, RecursionError):
                    raise RequestError(400, 'Invalid JSON value')
            store = self.server.store
            with store.lock:
                entries = store.live(store.entries)
                if route == '/v1/keys':
                    status, result = 200, {'keys': sorted(entries)}
                elif self.command == 'PUT':
                    status = 200 if key in entries else 201
                    entries[key] = {'value': body['value'], 'expires_at': expiry}
                    store.commit(entries)
                    result = {'key': key, 'value': body['value']}
                elif key not in entries:
                    raise RequestError(404, 'Key not found')
                elif self.command == 'DELETE':
                    del entries[key]
                    store.commit(entries)
                    status, result = 204, None
                else:
                    status, result = 200, {'key': key, 'value': entries[key]['value']}
            self.reply(status, result)
        except RequestError as exc:
            self.reply(exc.status, {'error': str(exc)})
        except (TimeoutError, ConnectionError):
            self.close_connection = True
        except Exception as exc:
            self.log_error('Request failed: %s', exc)
            self.reply(500, {'error': 'Internal server error'})


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


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
