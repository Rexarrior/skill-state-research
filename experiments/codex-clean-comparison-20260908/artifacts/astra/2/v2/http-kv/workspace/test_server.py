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
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.data = Path(self.temp.name) / 'data.json'
        self.start()

    def start(self):
        self.process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('server.py')), '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = self.process.stdout.readline().strip()
        self.assertTrue(line.startswith('LISTENING '), line)
        self.port = int(line.split()[1])

    def stop(self):
        self.process.terminate()
        self.process.wait(timeout=10)
        self.assertEqual(self.process.returncode, 0)
        self.assertEqual(self.process.stdout.read(), '')
        self.process.stdout.close()

    def tearDown(self):
        if self.process.poll() is None:
            self.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request(method, path, body=raw if raw is not None else (json.dumps(body) if body is not None else None), headers=headers or {})
            response = conn.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(data) if data else None
        finally:
            conn.close()

    def test_crud_and_restart(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        key = 'hello world ☃ +?%'
        path = '/v1/kv/' + quote(key, safe='')
        value = {'nested': [1, True, None, 'text']}
        self.assertEqual(self.request('PUT', path, {'value': value}), (201, {'key': key, 'value': value}))
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
        self.request('PUT', '/v1/kv/short', {'value': 1, 'ttl_seconds': 0.2})
        self.request('PUT', '/v1/kv/long', {'value': 2, 'ttl_seconds': 30})
        self.stop()
        time.sleep(0.25)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/short')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1], {'keys': ['long']})
        self.assertEqual(self.request('GET', '/v1/kv/long')[0], 200)
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 3})[0], 201)
        self.request('PUT', '/v1/kv/reset', {'value': 1, 'ttl_seconds': 0.1})
        self.request('PUT', '/v1/kv/reset', {'value': 2})
        time.sleep(0.15)
        self.assertEqual(self.request('GET', '/v1/kv/reset')[1]['value'], 2)

    def test_validation(self):
        for raw in ('', '{', '[]', 'null', '{}', '{"value":NaN}', '{"value":1e999}', '\ud800'.encode('utf-8', errors='surrogatepass')):
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/x', raw=raw)[0], 400)
        for ttl in (None, True, False, 0, -1, '2', [], {}, float('inf'), 10**400):
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request('PUT', '/v1/kv/x', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ('', 'a/b', 'a%2Fb', '%FF', '%', '%GG', '%ED%A0%80'):
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('POST', '/v1/keys')[0], 405)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)
        self.assertEqual(self.request('BREW', '/health')[0], 501)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw='x' * (1024 * 1024 + 1))[0], 413)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw='{}', headers={'Content-Length': '-1'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw='{}', headers={'Transfer-Encoding': 'chunked'})[0], 400)

    def test_concurrency(self):
        def put(i):
            return self.request('PUT', f'/v1/kv/{i:03}', {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(40))), [201] * 40)
            statuses = list(pool.map(lambda i: self.request('PUT', '/v1/kv/shared', {'value': i})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)
        expected = [f'{i:03}' for i in range(40)] + ['shared']
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], expected)
        self.assertEqual(sorted(json.loads(self.data.read_text())['entries']), expected)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], expected)


if __name__ == '__main__':
    unittest.main()
