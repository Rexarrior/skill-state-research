#!/usr/bin/env python3
"""A small persistent HTTP key-value service (Python 3.11+)."""
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
from urllib.parse import unquote_to_bytes, urlsplit

MAX_BODY = 1024 * 1024


def reject_constant(value):
    raise ValueError(f"invalid JSON constant: {value}")


def decode_json(raw):
    return json.loads(raw, parse_constant=reject_constant)


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
            data = decode_json(self.path.read_text(encoding='utf-8'))
            if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('entries'), dict):
                raise ValueError('invalid data file')
            for key, entry in data['entries'].items():
                if not valid_key(key) or not isinstance(entry, dict) or set(entry) != {'value', 'expires_at'}:
                    raise ValueError('invalid stored entry')
                expiry = entry['expires_at']
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('invalid stored expiration')
            self.entries = data['entries']
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Drop expired entries on startup, including from the persisted snapshot.
        self._commit(self._live())

    def _live(self):
        now = time.time()
        return {k: v for k, v in self.entries.items()
                if v['expires_at'] is None or v['expires_at'] > now}

    def _commit(self, entries):
        payload = json.dumps({'version': 1, 'entries': entries}, ensure_ascii=True,
                             allow_nan=False, separators=(',', ':')).encode('utf-8')
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix='.' + self.path.name + '.', delete=False) as f:
                name = f.name
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            os.replace(name, self.path)
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)
        self.entries = entries

    def access(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self._live()
            present = key in entries
            if method == 'PUT':
                entries[key] = {'value': value, 'expires_at': None if ttl is None else time.time() + ttl}
                self._commit(entries)
                return (200 if present else 201), {'key': key, 'value': value}
            if method == 'DELETE' and present:
                del entries[key]
            if entries != self.entries:
                self._commit(entries)
            if method == 'KEYS':
                return 200, {'keys': sorted(entries)}
            if not present:
                return 404, {'error': 'key not found'}
            if method == 'DELETE':
                return 204, None
            return 200, {'key': key, 'value': entries[key]['value']}


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also prevents unread invalid bodies from being
    # interpreted as a subsequent request.
    protocol_version = 'HTTP/1.0'

    def send_json(self, status, body):
        raw = b'' if body is None else json.dumps(body, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        if self.command != 'HEAD' and raw:
            self.wfile.write(raw)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('error',))[0]})

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def handle_api(self):
        try:
            self.dispatch()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception as exc:
            self.log_error('request failed: %s', exc)
            self.send_json(500, {'error': 'internal server error'})

    def dispatch(self):
        if self.headers.get('Transfer-Encoding') is not None:
            self.send_error(400, 'transfer encoding is unsupported')
            return
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
            self.send_error(400, 'invalid Content-Length')
            return
        try:
            length = int(lengths[0]) if lengths else 0
        except ValueError:
            self.send_error(413, 'request body too large')
            return
        if length > MAX_BODY:
            self.send_error(413, 'request body too large')
            return
        try:
            path = urlsplit(self.path).path
        except ValueError:
            self.send_error(400, 'invalid URL')
            return
        key = None
        if path.startswith('/v1/kv/'):
            encoded = path[len('/v1/kv/'):]
            try:
                if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
                    raise ValueError('invalid escape')
                key = unquote_to_bytes(encoded).decode('utf-8', errors='strict')
                if not valid_key(key):
                    raise ValueError('invalid key')
            except (ValueError, UnicodeError):
                self.send_error(400, 'invalid key')
                return
            allowed = ('GET', 'PUT', 'DELETE')
        elif path in ('/health', '/v1/keys'):
            allowed = ('GET',)
        else:
            self.send_error(404, 'unknown route')
            return
        if self.command not in allowed:
            self.send_error(405, 'method not allowed')
            return
        if self.command == 'PUT':
            if not lengths:
                self.send_error(411, 'Content-Length required')
                return
            try:
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('incomplete body')
                body = decode_json(raw.decode('utf-8'))
                if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
                    raise ValueError('expected value and optional ttl_seconds')
                ttl = body.get('ttl_seconds')
                if 'ttl_seconds' in body:
                    if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0 or not math.isfinite(time.time() + ttl):
                        raise ValueError('ttl_seconds must be finite and positive')
                # Also rejects floating point overflow (e.g. 1e999) in values.
                json.dumps(body['value'], allow_nan=False)
            except (ValueError, UnicodeError, OverflowError, RecursionError):
                self.send_error(400, 'invalid JSON body or TTL')
                return
            status, response = self.server.store.access('PUT', key, body['value'], ttl)
        elif path == '/health':
            status, response = 200, {'status': 'ok'}
        else:
            status, response = self.server.store.access('KEYS' if path == '/v1/keys' else self.command, key)
        self.send_json(status, response)

    do_GET = do_PUT = do_DELETE = do_POST = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT = handle_api

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.handle_api
        raise AttributeError(name)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True


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
        print(f'startup failed: {exc}', file=sys.stderr)
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
