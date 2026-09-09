#!/usr/bin/env python3
"""Dependency-free persistent HTTP key-value service."""
import argparse
import json
import math
import os
import re
import signal
import socket
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote_to_bytes, urlsplit

MAX_BODY = 1024 * 1024


def strict_json(data):
    def invalid_constant(value):
        raise ValueError('Non-finite JSON number')
    result = json.loads(data, parse_constant=invalid_constant)
    # Also rejects overflowing exponents and unpaired Unicode surrogates.
    json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8')
    return result


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
        self.path = os.path.abspath(path)
        self.lock = threading.Lock()
        self.entries = {}
        try:
            with open(self.path, 'rb') as source:
                entries = strict_json(source.read())
        except FileNotFoundError:
            entries = {}
        if not isinstance(entries, dict):
            raise ValueError('Invalid persistence file')
        for key, entry in entries.items():
            if (not valid_key(key) or not isinstance(entry, dict)
                    or set(entry) != {'value', 'expires_at'}):
                raise ValueError('Invalid persisted entry')
            expiry = entry['expires_at']
            if expiry is not None and (type(expiry) not in (int, float)
                                      or not math.isfinite(expiry)):
                raise ValueError('Invalid persisted expiration')
        self.entries = self.live(entries)

    @staticmethod
    def live(entries):
        now = time.time()
        return {k: v for k, v in entries.items()
                if v['expires_at'] is None or v['expires_at'] > now}

    def commit(self, entries):
        """Caller holds lock; publish memory only after disk replacement succeeds."""
        directory = os.path.dirname(self.path)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                                             dir=directory, delete=False) as output:
                temporary = output.name
                json.dump(entries, output, ensure_ascii=False, allow_nan=False)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            self.entries = entries
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def get(self, key):
        with self.lock:
            self.entries = self.live(self.entries)
            entry = self.entries.get(key)
            return None if entry is None else {'key': key, 'value': entry['value']}

    def keys(self):
        with self.lock:
            self.entries = self.live(self.entries)
            return sorted(self.entries)

    def put(self, key, value, ttl):
        with self.lock:
            entries = self.live(self.entries)
            created = key not in entries
            entries[key] = {'value': value, 'expires_at': None if ttl is None else time.time() + ttl}
            self.commit(entries)
            return created

    def delete(self, key):
        with self.lock:
            entries = self.live(self.entries)
            if key not in entries:
                return False
            del entries[key]
            self.commit(entries)
            return True


class RequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    # Close after each response so rejected or unread bodies cannot desynchronize requests.
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def finish(self):
        try:
            super().finish()
        finally:
            # Deliver the response and EOF before closing with unread request data.
            # A bounded drain avoids TCP resets while keeping shutdown bounded.
            try:
                self.connection.shutdown(socket.SHUT_WR)
                deadline = time.monotonic() + 1
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self.connection.settimeout(remaining)
                    if not self.connection.recv(65536):
                        break
            except OSError:
                pass

    def send_json(self, status, payload=None):
        body = b'' if status == 204 else json.dumps(payload, ensure_ascii=False,
                                                   allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        if code == 501:
            code, message = 405, 'Method not allowed'
        self.send_json(code, {'error': message or self.responses.get(code, ('Error',))[0]})

    def framing(self):
        if self.headers.get_all('Transfer-Encoding'):
            raise RequestError(400, 'Transfer-Encoding is not supported')
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
            raise RequestError(400, 'Invalid Content-Length')
        if lengths and (len(lengths[0]) > 10 or int(lengths[0]) > MAX_BODY):
            raise RequestError(413, 'Request body exceeds 1 MiB')
        return int(lengths[0]) if lengths else 0

    def route(self):
        try:
            path = urlsplit(self.path).path
        except ValueError:
            raise RequestError(400, 'Invalid URL')
        if path in ('/health', '/v1/keys'):
            return path, None
        prefix = '/v1/kv/'
        if not path.startswith(prefix):
            raise RequestError(404, 'Unknown route')
        encoded = path[len(prefix):]
        try:
            if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
                raise ValueError('Invalid escape')
            key = unquote_to_bytes(encoded).decode('utf-8')
        except (ValueError, UnicodeError):
            raise RequestError(400, 'Invalid UTF-8 key')
        if not valid_key(key):
            raise RequestError(400, 'Invalid key')
        return prefix, key

    def handle_request(self):
        try:
            length = self.framing()
            route, key = self.route()
            allowed = ('GET', 'PUT', 'DELETE') if key is not None else ('GET',)
            if self.command not in allowed:
                raise RequestError(405, 'Method not allowed')
            store = self.server.store
            if self.command == 'PUT':
                try:
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise ValueError('Incomplete body')
                    body = strict_json(raw.decode('utf-8'))
                except (ValueError, UnicodeError, RecursionError):
                    raise RequestError(400, 'Invalid JSON body')
                if not isinstance(body, dict) or 'value' not in body or set(body) - {'value', 'ttl_seconds'}:
                    raise RequestError(400, 'Expected value and optional ttl_seconds')
                ttl = body.get('ttl_seconds')
                if 'ttl_seconds' in body:
                    try:
                        valid = (type(ttl) in (int, float) and math.isfinite(ttl)
                                 and ttl > 0 and math.isfinite(time.time() + ttl))
                    except OverflowError:
                        valid = False
                    if not valid:
                        raise RequestError(400, 'ttl_seconds must be finite and positive')
                created = store.put(key, body['value'], ttl)
                self.send_json(201 if created else 200, {'key': key, 'value': body['value']})
            elif self.command == 'DELETE':
                if not store.delete(key):
                    raise RequestError(404, 'Key not found')
                self.send_json(204)
            elif route == '/health':
                self.send_json(200, {'status': 'ok'})
            elif route == '/v1/keys':
                self.send_json(200, {'keys': store.keys()})
            else:
                value = store.get(key)
                if value is None:
                    raise RequestError(404, 'Key not found')
                self.send_json(200, value)
        except RequestError as error:
            self.send_json(error.status, {'error': error.message})
        except TimeoutError:
            self.send_json(408, {'error': 'Request timed out'})
        except OSError as error:
            self.log_error('I/O error: %s', error)
            try:
                self.send_json(500, {'error': 'Storage or connection error'})
            except OSError:
                pass

    do_GET = do_PUT = do_DELETE = do_POST = do_PATCH = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT = handle_request


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
    except (OSError, ValueError, OverflowError, RecursionError) as error:
        print(f'Startup failed: {error}', file=sys.stderr)
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
