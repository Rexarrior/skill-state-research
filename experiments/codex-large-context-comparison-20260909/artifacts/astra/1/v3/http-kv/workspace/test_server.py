import concurrent.futures
import http.client
import json
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import quote


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.temp.name) / 'data.json'
        self.log = open(Path(self.temp.name) / 'stderr.log', 'w+')
        self.process = None
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('server.py')), '--host',
             '127.0.0.1', '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=self.log, text=True)
        self.assertTrue(select.select([self.process.stdout], [], [], 5)[0], 'startup timed out')
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r'^LISTENING \d+$')
        self.port = int(line.split()[1])

    def stop(self):
        self.process.send_signal(signal.SIGTERM)
        self.assertEqual(self.process.wait(timeout=5), 0)
        self.assertEqual(self.process.stdout.read(), '')
        self.process.stdout.close()
        self.process = None

    def tearDown(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process.stdout.close()
        self.log.close()
        self.temp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            data = raw if raw is not None else (json.dumps(body) if body is not None else None)
            connection.request(method, path, body=data, headers=headers or {})
            response = connection.getresponse()
            content = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(content) if content else None
        finally:
            connection.close()

    def test_api_and_restart(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        key = 'snow ☃ + space'
        path = '/v1/kv/' + quote(key, safe='')
        value = {'nested': [None, True, 3.5, 'hello']}
        self.assertEqual(self.request('PUT', path, {'value': value})[0], 201)
        self.assertEqual(self.request('GET', path), (200, {'key': key, 'value': value}))
        self.assertEqual(self.request('PUT', path, {'value': False})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', path), (200, {'key': key, 'value': False}))
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': [key]}))
        self.assertEqual(self.request('DELETE', path), (204, None))
        self.assertEqual(self.request('DELETE', path)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', path)[0], 404)

    def test_expiration(self):
        self.request('PUT', '/v1/kv/short', {'value': 1, 'ttl_seconds': 0.15})
        time.sleep(0.2)
        self.assertEqual(self.request('GET', '/v1/kv/short')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 2})[0], 201)
        self.request('PUT', '/v1/kv/offline', {'value': 3, 'ttl_seconds': 0.3})
        self.request('PUT', '/v1/kv/long', {'value': 4, 'ttl_seconds': 60})
        self.stop()
        time.sleep(0.35)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/offline')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], ['long', 'short'])
        self.assertNotIn('offline', json.loads(self.data.read_text())['entries'])

    def test_invalid_requests(self):
        for body in ([], 1, {}, {'value': 1, 'extra': 2}):
            self.assertEqual(self.request('PUT', '/v1/kv/x', body)[0], 400)
        for ttl in (None, True, False, 0, -1, '2', [], {}, float('inf'), float('nan'), 10**400):
            with self.subTest(ttl=str(ttl)[:30]):
                self.assertEqual(self.request('PUT', '/v1/kv/x', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for raw in ('{', '', '{"value": NaN}', '{"value": 1e999}', b'{"value":"\xff"}'):
            self.assertEqual(self.request('PUT', '/v1/kv/x', raw=raw)[0], 400)
        for key in ('', '%2F', 'a/b', '%FF', '%', '%GG'):
            self.assertEqual(self.request('GET', '/v1/kv/' + key)[0], 400)
        for method in ('POST', 'PATCH', 'OPTIONS', 'BOGUS'):
            self.assertEqual(self.request(method, '/v1/kv/x')[0], 405)
        self.assertEqual(self.request('GET', '/missing')[0], 404)
        self.assertEqual(self.request('PUT', '/health', {'value': 1})[0], 405)
        exact = '{"value":"' + 'x' * (1024*1024 - 12) + '"}'
        self.assertEqual(len(exact), 1024*1024)
        self.assertEqual(self.request('PUT', '/v1/kv/limit', raw=exact)[0], 201)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw='x' * (1024*1024 + 1))[0], 413)
        self.assertEqual(self.request('GET', '/health', headers={'Content-Length': '-1'})[0], 400)
        self.assertEqual(self.request('GET', '/health', headers={'Transfer-Encoding': 'chunked'})[0], 400)
        self.assertEqual(self.request('GET', '/health')[0], 200)

    def test_concurrent_writes(self):
        def put(i):
            return self.request('PUT', f'/v1/kv/key{i:03}', {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(60))), [201] * 60)
        expected = [f'key{i:03}' for i in range(60)]
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], expected)
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            results = list(pool.map(lambda i: self.request('PUT', '/v1/kv/shared', {'value': i})[0], range(30)))
        self.assertEqual(results.count(201), 1)
        self.assertEqual(results.count(200), 29)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], expected + ['shared'])
        self.assertEqual(len(json.loads(self.data.read_text())['entries']), 61)

    def test_shutdown_with_idle_client(self):
        client = socket.create_connection(('127.0.0.1', self.port))
        try:
            client.sendall(b'PUT /v1/kv/x HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20\r\n\r\n{')
            time.sleep(0.05)
            self.stop()
        finally:
            client.close()


if __name__ == '__main__':
    unittest.main()
