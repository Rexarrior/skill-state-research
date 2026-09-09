#!/usr/bin/env python3
"""Dependency-free persistent HTTP key-value service."""
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
    raise ValueError(f"Invalid JSON constant: {value}")


def decode_json(data):
    return json.loads(data.decode('utf-8'), parse_constant=reject_constant)


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
            self.entries = document['entries']
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.entries = self.live()
        self.persist(self.entries)

    def live(self):
        now = time.time()
        return {key: entry for key, entry in self.entries.items()
                if entry['expires_at'] is None or entry['expires_at'] > now}

    def persist(self, entries):
        # Write beside the destination so replacement stays on one filesystem.
        data = json.dumps({'version': 1, 'entries': entries}, ensure_ascii=True, allow_nan=False).encode('utf-8')
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix='.' + self.path.name + '.', delete=False) as file:
                temp_path = file.name
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temp_path, self.path)
        finally:
            if temp_path is not None and os.path.exists(temp_path):
                os.unlink(temp_path)

    def execute(self, method, key=None, value=None, ttl=None):
        with self.lock:
            entries = self.live()
            present = key in entries
            if method == 'PUT':
                expiry = None if ttl is None else time.time() + ttl
                if expiry is not None and not math.isfinite(expiry):
                    raise ValueError('TTL is too large')
                entries[key] = {'value': value, 'expires_at': expiry}
                status, body = (200 if present else 201), {'key': key, 'value': value}
            elif method == 'DELETE':
                if present:
                    del entries[key]
                status, body = (204, None) if present else (404, {'error': 'Key not found'})
            elif method == 'GET':
                status, body = (200, {'key': key, 'value': entries[key]['value']}) if present else (404, {'error': 'Key not found'})
            else:
                status, body = 200, {'keys': sorted(entries)}
            if method == 'PUT' or entries != self.entries:
                self.persist(entries)
                self.entries = entries
            return status, body

    def close(self):
        with self.lock:
            self.entries = self.live()
            self.persist(self.entries)


class Handler(BaseHTTPRequestHandler):
    # Closing each connection avoids ambiguous request framing and unread bodies.
    protocol_version = 'HTTP/1.0'

    def log_message(self, fmt, *args):
        print('%s - %s' % (self.address_string(), fmt % args), file=sys.stderr, flush=True)

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def send_json(self, status, body):
        data = b'' if body is None else json.dumps(body, ensure_ascii=True, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {'error': message or self.responses.get(code, ('Request failed',))[0]})

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self.handle_api
        raise AttributeError(name)

    def handle_api(self):
        try:
            self.dispatch()
        except (ValueError, UnicodeError, RecursionError, OverflowError) as exc:
            self.send_json(400, {'error': str(exc) or 'Invalid request'})
        except TimeoutError:
            self.send_json(408, {'error': 'Request timed out'})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.log_message('Request failed: %s', exc)
            self.send_json(500, {'error': 'Internal server error'})

    def dispatch(self):
        if self.headers.get('Transfer-Encoding') is not None:
            self.send_json(400, {'error': 'Transfer-Encoding is unsupported'})
            return
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
            raise ValueError('Invalid Content-Length')
        length = int(lengths[0]) if lengths else 0
        if length > MAX_BODY:
            self.send_json(413, {'error': 'Request body exceeds 1 MiB'})
            # Allow an in-flight upload to finish so closing the socket does not
            # discard the error response. Bound both time and discarded bytes.
            self.wfile.flush()
            deadline = time.monotonic() + 1
            remaining = min(length, 2 * MAX_BODY)
            try:
                while remaining and time.monotonic() < deadline:
                    self.connection.settimeout(max(0.001, deadline - time.monotonic()))
                    chunk = self.rfile.read1(min(65536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
            except OSError:
                pass
            return
        path = urlsplit(self.path).path
        if path in ('/health', '/v1/keys'):
            if self.command != 'GET':
                self.send_json(405, {'error': 'Method not allowed'})
            elif path == '/health':
                self.send_json(200, {'status': 'ok'})
            else:
                self.send_json(*self.server.store.execute('KEYS'))
            return
        if not path.startswith('/v1/kv/'):
            self.send_json(404, {'error': 'Unknown route'})
            return
        encoded = path[len('/v1/kv/'):]
        if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
            raise ValueError('Invalid percent-encoding')
        key = unquote_to_bytes(encoded).decode('utf-8')
        if not valid_key(key):
            raise ValueError('Invalid key')
        if self.command not in ('GET', 'PUT', 'DELETE'):
            self.send_json(405, {'error': 'Method not allowed'})
            return
        if self.command == 'PUT':
            if not lengths:
                self.send_json(411, {'error': 'Content-Length required'})
                return
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('Incomplete request body')
            body = decode_json(raw)
            if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
                raise ValueError('Expected value and optional ttl_seconds')
            ttl = body.get('ttl_seconds')
            if 'ttl_seconds' in body:
                if type(ttl) not in (int, float) or not math.isfinite(ttl) or ttl <= 0:
                    raise ValueError('ttl_seconds must be finite and greater than zero')
            # Reject numeric overflow anywhere in the supplied JSON value.
            json.dumps(body['value'], allow_nan=False)
            self.send_json(*self.server.store.execute('PUT', key, body['value'], ttl))
        else:
            self.send_json(*self.server.store.execute(self.command, key))


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
        server.store = store
    except Exception as exc:
        print(f'Startup failed: {exc}', file=sys.stderr)
        return 1

    def stop(signum, frame):
        # shutdown must run outside the serve_forever thread.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f'LISTENING {server.server_address[1]}', flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        store.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
