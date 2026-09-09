#!/usr/bin/env python3
"""A dependency-free, persistent HTTP key-value service."""
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


def decode_json(raw):
    return json.loads(raw, parse_constant=reject_constant)


def encode_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('utf-8')


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.entries = {}
        if self.path.exists():
            data = decode_json(self.path.read_text(encoding='utf-8'))
            if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('entries'), dict):
                raise ValueError('Invalid data file')
            for key, entry in data['entries'].items():
                if not key or '/' in key or not isinstance(entry, dict) or 'value' not in entry:
                    raise ValueError('Invalid persisted entry')
                key.encode('utf-8')
                expiry = entry.get('expires_at')
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('Invalid persisted expiry')
            encode_json(data)
            self.entries = self.live(data['entries'])
        self.persist(self.entries)

    @staticmethod
    def live(entries):
        now = time.time()
        return {k: v for k, v in entries.items() if v.get('expires_at') is None or v['expires_at'] > now}

    def persist(self, entries):
        payload = encode_json({'version': 1, 'entries': entries})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.' + self.path.name + '.', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def operate(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live(self.entries)
            present = key in entries
            if method == 'PUT':
                expiry = None if ttl is None else time.time() + ttl
                if expiry is not None and not math.isfinite(expiry):
                    raise ValueError('TTL is too large')
                entries[key] = {'value': value, 'expires_at': expiry}
                result = (200 if present else 201, {'key': key, 'value': value})
            elif method == 'DELETE':
                if present:
                    del entries[key]
                result = (204, None) if present else (404, {'error': 'Key not found'})
            elif method == 'GET':
                result = (200, {'key': key, 'value': entries[key]['value']}) if present else (404, {'error': 'Key not found'})
            else:
                result = (200, {'keys': sorted(entries)})
            if entries != self.entries:
                self.persist(entries)
                self.entries = entries
            return result


class Handler(BaseHTTPRequestHandler):
    # Closing each connection also prevents unread invalid bodies from becoming requests.
    protocol_version = 'HTTP/1.0'

    def reply(self, status, body):
        payload = b'' if status == 204 else encode_json(body)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {'error': message or self.responses.get(code, ('Error',))[0]})

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.unsupported
        raise AttributeError(name)

    def unsupported(self):
        self.reply(405, {'error': 'Unsupported method'})

    def dispatch(self):
        try:
            lengths = self.headers.get_all('Content-Length', [])
            if self.headers.get('Transfer-Encoding') is not None:
                self.reply(400, {'error': 'Transfer-Encoding is not supported'})
                return
            if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
                raise ValueError('Invalid Content-Length')
            length = int(lengths[0]) if lengths else 0
            if length > MAX_BODY:
                self.reply(413, {'error': 'Request body exceeds 1 MiB'})
                return
            path = urlsplit(self.path).path
            if path == '/health' or path == '/v1/keys':
                if self.command != 'GET':
                    self.unsupported()
                elif path == '/health':
                    self.reply(200, {'status': 'ok'})
                else:
                    self.reply(*self.server.store.operate('KEYS'))
                return
            if not path.startswith('/v1/kv/'):
                self.reply(404, {'error': 'Unknown route'})
                return
            encoded = path[len('/v1/kv/'):]
            if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
                raise ValueError('Invalid key encoding')
            key = unquote_to_bytes(encoded).decode('utf-8', errors='strict')
            if not key or '/' in key:
                raise ValueError('Key must be nonempty and cannot contain /')
            value, ttl = None, None
            if self.command == 'PUT':
                if not lengths:
                    self.reply(411, {'error': 'Content-Length required'})
                    return
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('Incomplete body')
                body = decode_json(raw.decode('utf-8'))
                if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
                    raise ValueError('Expected value and optional ttl_seconds')
                value = body['value']
                encode_json(value)
                if 'ttl_seconds' in body:
                    ttl = body['ttl_seconds']
                    if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0:
                        raise ValueError('ttl_seconds must be finite and positive')
            self.reply(*self.server.store.operate(self.command, key, value, ttl))
        except (ValueError, UnicodeError, OverflowError, RecursionError) as exc:
            self.reply(400, {'error': str(exc)})
        except OSError as exc:
            print(f'Request I/O error: {exc}', file=sys.stderr)
            self.reply(500, {'error': 'Storage or connection failure'})

    do_GET = dispatch
    do_PUT = dispatch
    do_DELETE = dispatch


class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(5)
        return sock, address


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', required=True, type=int)
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
