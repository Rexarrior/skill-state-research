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
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.temp.name) / 'data.json'
        self.start()

    def start(self):
        self.proc = subprocess.Popen([sys.executable, 'server.py', '--host', '127.0.0.1',
                                      '--port', '0', '--data', str(self.data)],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = self.proc.stdout.readline()
        self.assertTrue(line.startswith('LISTENING '), line)
        self.port = int(line.split()[1])

    def stop(self):
        self.proc.terminate()
        self.assertEqual(self.proc.wait(timeout=15), 0)
        self.assertEqual(self.proc.stdout.read(), '')
        self.proc.stdout.close()

    def tearDown(self):
        if self.proc.poll() is None:
            self.stop()
        self.temp.cleanup()

    def request(self, method, path, value=None, raw=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        body = raw if raw is not None else (json.dumps(value) if value is not None else None)
        conn.request(method, path, body=body, headers={'Content-Type': 'application/json'})
        response = conn.getresponse()
        content = response.read()
        self.assertEqual(response.getheader('Content-Type'), 'application/json')
        result = response.status, json.loads(content) if content else None
        conn.close()
        return result

    def test_crud_and_restart(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        key = 'hello ☃ + world'
        path = '/v1/kv/' + quote(key, safe='')
        value = {'nested': [None, True, 1, 1.5, 'x']}
        self.assertEqual(self.request('PUT', path, {'value': value})[0], 201)
        self.assertEqual(self.request('GET', path), (200, {'key': key, 'value': value}))
        self.assertEqual(self.request('PUT', path, {'value': False})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', path), (200, {'key': key, 'value': False}))
        self.assertEqual(self.request('DELETE', path), (204, None))
        self.assertEqual(self.request('DELETE', path)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', path)[0], 404)

    def test_expiry(self):
        self.request('PUT', '/v1/kv/short', {'value': 1, 'ttl_seconds': 0.15})
        self.request('PUT', '/v1/kv/reset', {'value': 1, 'ttl_seconds': 0.15})
        self.request('PUT', '/v1/kv/reset', {'value': 2})
        self.stop()
        time.sleep(0.2)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/short')[0], 404)
        self.assertEqual(self.request('DELETE', '/v1/kv/short')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['reset']}))
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 3})[0], 201)

    def test_validation(self):
        for raw in ('{', '[]', '{}', 'null', '{"value":NaN}', '{"value":1e999}', b'\xff'):
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/x', raw=raw)[0], 400)
        for ttl in (0, -1, True, None, '2', float('inf'), 10**400):
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request('PUT', '/v1/kv/x', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ('', 'a/b', 'a%2Fb', '%FF', '%', '%GG', '%ED%A0%80'):
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('POST', '/v1/kv/x', {})[0], 405)
        self.assertEqual(self.request('PATCH', '/health', {})[0], 405)
        self.assertEqual(self.request('PUT', '/v1/keys', {})[0], 405)
        self.assertEqual(self.request('GET', '/missing')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw='x' * (1024 * 1024 + 1))[0], 413)
        raw = '{"value":"' + 'x' * (1024 * 1024 - 12) + '"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/limit', raw=raw)[0], 201)

    def test_concurrency(self):
        def put(i):
            return self.request('PUT', f'/v1/kv/{i:03}', {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(40))), [201] * 40)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': [f'{i:03}' for i in range(40)]}))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.request('PUT', '/v1/kv/shared', {'value': i})[0], range(20)))
        self.assertEqual(results.count(201), 1)
        self.assertEqual(results.count(200), 19)
        snapshot = json.loads(self.data.read_text())
        self.assertEqual(len(snapshot['entries']), 41)


if __name__ == '__main__':
    unittest.main()
