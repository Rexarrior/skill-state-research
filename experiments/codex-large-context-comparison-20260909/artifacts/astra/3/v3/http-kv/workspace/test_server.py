"""Black-box integration tests using only the Python standard library."""
import concurrent.futures
import http.client
import json
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import quote


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.temp.name) / 'state.json'
        self.process = None
        self.start()

    def start(self):
        self.log = open(Path(self.temp.name) / 'stderr.log', 'ab')
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('server.py')), '--host', '127.0.0.1',
             '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=self.log, text=True)
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(5), 'Server failed to announce its port')
        line = self.process.stdout.readline()
        self.assertRegex(line, r'^LISTENING [0-9]+\n$')
        self.port = int(line.split()[1])

    def stop(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.assertEqual(self.process.wait(timeout=15), 0)
                self.assertEqual(self.process.stdout.read(), '')
            finally:
                if self.process.poll() is None:
                    self.process.kill()
                    self.process.wait()
                self.process.stdout.close()
                self.log.close()
                self.process = None

    def tearDown(self):
        try:
            self.stop()
        finally:
            self.temp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            connection.request(method, path, body=data, headers=headers or {})
            response = connection.getresponse()
            payload = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            if response.status == 204:
                self.assertEqual(payload, b'')
            result = json.loads(payload) if payload else None
            if response.status >= 400 and method != 'HEAD':
                self.assertIsInstance(result['error'], str)
            return response.status, result
        finally:
            connection.close()

    def put(self, key, value, **kwargs):
        return self.request('PUT', '/v1/kv/' + quote(key, safe=''), {'value': value, **kwargs})

    def test_crud_and_keys(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        for key in ['z', 'a space', '日本語', 'a+b']:
            self.assertEqual(self.put(key, {'nested': [None, True, 2.5]})[0], 201)
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], ['a space', 'a+b', 'z', '日本語'])
        self.assertEqual(self.put('a space', False)[0], 200)
        self.assertEqual(self.request('GET', '/v1/kv/a%20space'), (200, {'key': 'a space', 'value': False}))
        self.assertEqual(self.request('DELETE', '/v1/kv/a%20space')[0], 204)
        self.assertEqual(self.request('DELETE', '/v1/kv/a%20space')[0], 404)
        self.assertEqual(self.request('GET', '/v1/kv/missing')[0], 404)

    def test_restart_and_expiration(self):
        self.put('durable', [1, 'two'])
        self.put('expiring', 'gone', ttl_seconds=0.4)
        self.put('renewed', 1, ttl_seconds=0.1)
        self.assertEqual(self.put('renewed', 2)[0], 200)
        self.stop()
        time.sleep(0.5)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/durable')[1]['value'], [1, 'two'])
        self.assertEqual(self.request('GET', '/v1/kv/expiring')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], ['durable', 'renewed'])
        self.put('short', 1, ttl_seconds=0.02)
        time.sleep(0.04)
        self.assertEqual(self.put('short', 2)[0], 201)
        self.put('delete-expired', 1, ttl_seconds=0.02)
        time.sleep(0.04)
        self.assertEqual(self.request('DELETE', '/v1/kv/delete-expired')[0], 404)
        self.stop()
        persisted = json.loads(self.data.read_text())
        self.assertNotIn('expiring', persisted['entries'])
        self.assertNotIn('delete-expired', persisted['entries'])
        self.start()

    def test_invalid_requests(self):
        for raw in [b'{', b'[]', b'null', b'{}', b'{"value":NaN}', b'{"value":1e999}', b'\xff', b'{"value":1,"extra":2}']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/test', raw=raw)[0], 400)
        for ttl in [None, True, False, 0, -1, '1', [], {}, float('inf'), float('nan'), 10**400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.put('test', 1, ttl_seconds=ttl)[0], 400)
        for key in ['', 'a/b', '%2F', '%FF', '%', '%GG', '%ED%A0%80']:
            with self.subTest(key=key):
                self.assertEqual(self.request('GET', '/v1/kv/' + key)[0], 400)
        self.assertEqual(self.request('PATCH', '/v1/kv/a')[0], 405)
        self.assertEqual(self.request('POST', '/health')[0], 405)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)
        self.assertEqual(self.request('GET', '/health', headers={'Content-Length': '0' * 5000})[0], 200)
        self.assertEqual(self.request('PUT', '/v1/kv/a', headers={'Content-Length': '0' * 5000 + '1048577'})[0], 413)
        for length in ['-1', 'abc']:
            self.assertEqual(self.request('PUT', '/v1/kv/a', headers={'Content-Length': length})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/a', headers={'Transfer-Encoding': 'chunked'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/a', headers={'Content-Length': str(1024 * 1024 + 1)})[0], 413)
        self.assertEqual(self.request('GET', '/health')[0], 200)

    def test_body_boundary(self):
        raw = b'{"value":"' + b'x' * (1024 * 1024 - 12) + b'"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/large', raw=raw)[0], 201)
        self.assertEqual(len(self.request('GET', '/v1/kv/large')[1]['value']), 1024 * 1024 - 12)

    def test_concurrent_writes(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(lambda i: self.put(f'key-{i:02}', i)[0], range(32)))
            self.assertEqual(statuses, [201] * 32)
            same_key = list(pool.map(lambda i: self.put('shared', i)[0], range(16)))
            self.assertEqual(same_key.count(201), 1)
            self.assertEqual(same_key.count(200), 15)
        self.stop()
        self.start()
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 33)
        for i in range(32):
            self.assertEqual(self.request('GET', f'/v1/kv/key-{i:02}')[1]['value'], i)


if __name__ == '__main__':
    unittest.main()
