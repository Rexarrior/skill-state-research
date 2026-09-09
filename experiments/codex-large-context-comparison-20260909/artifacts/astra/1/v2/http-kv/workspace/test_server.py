"""Black-box tests using only the Python standard library."""
import concurrent.futures
import http.client
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import quote


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name) / 'data.json'
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('server.py')),
             '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
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
                self.process = None

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            payload = json.dumps(body).encode() if body is not None else raw
            connection.request(method, path, payload, headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_and_keys(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        value = {'nested': [None, True, 1, 2.5, '世界']}
        key = 'a space 世界?%#'
        url = '/v1/kv/' + quote(key, safe='')
        self.assertEqual(self.request('PUT', url, {'value': value})[0], 201)
        self.assertEqual(self.request('GET', url), (200, {'key': key, 'value': value}))
        self.assertEqual(self.request('PUT', url, {'value': None})[0], 200)
        self.request('PUT', '/v1/kv/z', {'value': 1})
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': [key, 'z']}))
        self.assertEqual(self.request('DELETE', url), (204, None))
        self.assertEqual(self.request('DELETE', url)[0], 404)
        self.assertEqual(self.request('GET', url)[0], 404)

    def test_validation(self):
        for raw in [b'', b'{', b'[]', b'null', b'1', b'{}', b'{"value":NaN}',
                    b'{"value":1e999}', b'{"value":"\xff"}', b'{"value":0,"extra":1}']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/a', raw=raw)[0], 400)
        for ttl in [None, True, False, 0, -1, '1', [], {}, float('inf'), float('nan'), 10**400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request('PUT', '/v1/kv/a', {'value': 0, 'ttl_seconds': ttl})[0], 400)
        for key in ['', '%2F', 'a/b', '%ff', '%', '%xy', '%ED%A0%80']:
            with self.subTest(key=key):
                self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 0})[0], 400)
        for method in ['POST', 'PATCH', 'OPTIONS', 'TRACE', 'CUSTOM']:
            status, body = self.request(method, '/v1/kv/a')
            self.assertEqual(status, 405)
            self.assertIn('error', body)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)
        self.assertEqual(self.request('PUT', '/health', {'value': 0})[0], 405)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw=b'x' * (1024 * 1024 + 1))[0], 413)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw=b'{}', headers={'Content-Length': '-1'})[0], 400)

    def test_size_boundary(self):
        raw = b'{"value":"' + b'x' * (1024 * 1024 - 12) + b'"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/large', raw=raw)[0], 201)

    def test_restart_and_expiration(self):
        self.request('PUT', '/v1/kv/permanent', {'value': [1, 2]})
        self.request('PUT', '/v1/kv/expiring', {'value': 1, 'ttl_seconds': 0.5})
        self.request('PUT', '/v1/kv/reset', {'value': 1, 'ttl_seconds': 0.1})
        self.request('PUT', '/v1/kv/reset', {'value': 2})
        self.stop()
        time.sleep(0.55)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/permanent')[1]['value'], [1, 2])
        self.assertEqual(self.request('GET', '/v1/kv/reset')[1]['value'], 2)
        self.assertEqual(self.request('GET', '/v1/kv/expiring')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], ['permanent', 'reset'])
        self.assertNotIn('expiring', json.loads(self.data.read_text())['entries'])
        self.request('PUT', '/v1/kv/short', {'value': 1, 'ttl_seconds': 0.02})
        time.sleep(0.04)
        self.assertEqual(self.request('DELETE', '/v1/kv/short')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 3})[0], 201)
        self.request('DELETE', '/v1/kv/permanent')
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/permanent')[0], 404)

    def test_concurrent_writes(self):
        def write(index):
            return self.request('PUT', f'/v1/kv/key{index:03}', {'value': index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(write, range(60))), [201] * 60)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            statuses = list(pool.map(lambda i: self.request('PUT', '/v1/kv/shared', {'value': i})[0], range(30)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 29)
        self.stop()
        self.start()
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 61)
        for i in range(60):
            self.assertEqual(self.request('GET', f'/v1/kv/key{i:03}')[1]['value'], i)


if __name__ == '__main__':
    unittest.main()
