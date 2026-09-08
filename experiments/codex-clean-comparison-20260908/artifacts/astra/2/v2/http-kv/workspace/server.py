#!/usr/bin/env python3
"""A persistent, dependency-free HTTP key-value service."""
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
    return isinstance(key, str) and bool(key) and '/' not in key and not any(
        0xD800 <= ord(c) <= 0xDFFF for c in key
    )


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
                if not valid_key(key) or not isinstance(entry, dict) or 'value' not in entry or 'expires_at' not in entry:
                    raise ValueError('Invalid persisted entry')
                expiry = entry['expires_at']
                if expiry is not None and (type(expiry) not in (int, float) or not math.isfinite(expiry)):
                    raise ValueError('Invalid persisted expiration')
            self.entries = document['entries']
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.entries = self.live_entries()
        self.persist(self.entries)

    def live_entries(self):
        now = time.time()
        return {k: v for k, v in self.entries.items() if v['expires_at'] is None or v['expires_at'] > now}

    def persist(self, entries):
        data = json.dumps({'version': 1, 'entries': entries}, ensure_ascii=True, allow_nan=False).encode('utf-8')
        name = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=f'.{self.path.name}.', delete=False) as stream:
                name = stream.name
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
        finally:
            if name is not None and os.path.exists(name):
                os.unlink(name)

    def request(self, method, key=None, value=None, ttl=None):
        with self.lock:
            live = self.live_entries()
            if method == 'PUT':
                status = 200 if key in live else 201
                live[key] = {'value': value, 'expires_at': None if ttl is None else time.time() + ttl}
                response = {'key': key, 'value': value}
            elif method == 'DELETE':
                status = 204 if key in live else 404
                live.pop(key, None)
                response = None if status == 204 else {'error': 'Key not found'}
            elif method == 'GET':
                status = 200 if key in live else 404
                response = {'key': key, 'value': live[key]['value']} if status == 200 else {'error': 'Key not found'}
            else:
                status, response = 200, {'keys': sorted(live)}
            if method == 'PUT' or live != self.entries:
                self.persist(live)
                self.entries = live
            return status, response


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
    # Close each connection so rejected bodies cannot become another request.
    protocol_version = 'HTTP/1.0'

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

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def body_length(self):
        if self.headers.get_all('Transfer-Encoding'):
            raise APIError(400, 'Transfer-Encoding is unsupported')
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
            raise APIError(400, 'Invalid Content-Length')
        if lengths and (len(lengths[0]) > 10 or int(lengths[0]) > MAX_BODY):
            raise APIError(413, 'Request body exceeds 1 MiB')
        return int(lengths[0]) if lengths else 0

    def dispatch(self):
        try:
            length = self.body_length()
            try:
                path = urlsplit(self.path).path
            except ValueError:
                raise APIError(400, 'Invalid URL')
            key = None
            if path.startswith('/v1/kv/'):
                encoded = path[len('/v1/kv/'):]
                if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
                    raise APIError(400, 'Invalid key encoding')
                try:
                    key = unquote_to_bytes(encoded).decode('utf-8')
                except (UnicodeError, ValueError):
                    raise APIError(400, 'Key must be UTF-8')
                if not valid_key(key):
                    raise APIError(400, 'Key must be nonempty and must not contain /')
                allowed = ('GET', 'PUT', 'DELETE')
            elif path in ('/health', '/v1/keys'):
                allowed = ('GET',)
            else:
                raise APIError(404, 'Unknown route')
            if self.command not in allowed:
                raise APIError(405, 'Method not allowed')
            if self.command == 'PUT':
                try:
                    raw = self.rfile.read(length)
                except TimeoutError:
                    raise APIError(408, 'Request body timed out')
                if len(raw) != length:
                    raise APIError(400, 'Incomplete request body')
                try:
                    body = decode_json(raw)
                    # Also reject overflowed floats and unencodable nested values.
                    json.dumps(body, allow_nan=False)
                except (ValueError, UnicodeError, RecursionError):
                    raise APIError(400, 'Malformed JSON')
                if not isinstance(body, dict) or 'value' not in body:
                    raise APIError(400, 'Expected an object containing value')
                ttl = body.get('ttl_seconds')
                if 'ttl_seconds' in body:
                    try:
                        valid = type(ttl) in (int, float) and math.isfinite(ttl) and ttl > 0 and math.isfinite(time.time() + ttl)
                    except OverflowError:
                        valid = False
                    if not valid:
                        raise APIError(400, 'ttl_seconds must be finite and greater than zero')
                status, response = self.server.store.request('PUT', key, body['value'], ttl)
            elif path == '/health':
                status, response = 200, {'status': 'ok'}
            else:
                status, response = self.server.store.request('LIST' if path == '/v1/keys' else self.command, key)
            self.send_json(status, response)
        except APIError as exc:
            self.send_json(exc.status, {'error': exc.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
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
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--data', required=True)
    args = parser.parse_args()
    try:
        store = Store(args.data)
        server = Server((args.host, args.port), Handler)
        server.store = store
    except (OSError, ValueError, OverflowError) as exc:
        print(f'Startup failed: {exc}', file=sys.stderr)
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
        with store.lock:
            store.persist(store.live_entries())
    return 0


if __name__ == '__main__':
    sys.exit(main())
