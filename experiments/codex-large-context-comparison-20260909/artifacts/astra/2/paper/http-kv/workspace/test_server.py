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
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.tmp.name) / 'data.json'
        self.start()

    def start(self):
        self.log = open(Path(self.tmp.name) / 'stderr.log', 'ab')
        self.proc = subprocess.Popen([sys.executable, 'server.py', '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)], stdout=subprocess.PIPE, stderr=self.log, text=True)
        line = self.proc.stdout.readline().strip()
        self.assertRegex(line, r'^LISTENING \d+$')
        self.port = int(line.split()[1])

    def stop(self):
        self.proc.terminate()
        self.assertEqual(self.proc.wait(timeout=15), 0)
        self.assertEqual(self.proc.stdout.read(), '')
        self.proc.stdout.close()
        self.log.close()

    def tearDown(self):
        if self.proc.poll() is None:
            self.stop()
        self.tmp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        payload = raw if raw is not None else (json.dumps(body) if body is not None else None)
        conn.request(method, path, body=payload, headers=headers or {})
        response = conn.getresponse()
        data = response.read()
        self.assertEqual(response.getheader('Content-Type'), 'application/json')
        result = (response.status, json.loads(data) if data else None)
        conn.close()
        return result

    def test_crud_and_restart(self):
        key = quote('hello 世界', safe='')
        path = '/v1/kv/' + key
        value = {'nested': [None, True, 123, 'text']}
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        self.assertEqual(self.request('PUT', path, {'value': value})[0], 201)
        self.assertEqual(self.request('GET', path), (200, {'key': 'hello 世界', 'value': value}))
        self.assertEqual(self.request('PUT', path, {'value': False})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', path)[1]['value'], False)
        self.assertEqual(self.request('DELETE', path), (204, None))
        self.assertEqual(self.request('DELETE', path)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', path)[0], 404)

    def test_equal_python_values_are_replaced(self):
        path = '/v1/kv/types'
        self.assertEqual(self.request('PUT', path, {'value': True})[0], 201)
        for value in [1, 1.0, True, {'nested': [False]}, {'nested': [0]}]:
            with self.subTest(value=value):
                self.assertEqual(self.request('PUT', path, {'value': value})[0], 200)
                self.assertEqual(json.dumps(self.request('GET', path)[1]['value']), json.dumps(value))
                self.stop()
                self.start()
                self.assertEqual(json.dumps(self.request('GET', path)[1]['value']), json.dumps(value))

    def test_expiration(self):
        self.request('PUT', '/v1/kv/short', {'value': 1, 'ttl_seconds': 0.2})
        self.stop()
        time.sleep(0.25)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/short')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1], {'keys': []})
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 2, 'ttl_seconds': 0.1})[0], 201)
        time.sleep(0.15)
        self.assertEqual(self.request('DELETE', '/v1/kv/short')[0], 404)
        self.request('PUT', '/v1/kv/reset', {'value': 1, 'ttl_seconds': 0.1})
        self.request('PUT', '/v1/kv/reset', {'value': 2})
        time.sleep(0.15)
        self.assertEqual(self.request('GET', '/v1/kv/reset')[1]['value'], 2)

    def test_validation(self):
        for raw in ['{', '[]', '{}', 'null', '{"value":NaN}', '{"value":1e999}', '{"value":1,"extra":2}']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/a', raw=raw)[0], 400)
        for ttl in [0, -1, True, None, '5', float('inf'), float('nan'), 10**400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request('PUT', '/v1/kv/a', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ['', 'a/b', 'a%2Fb', '%FF', '%', '%XY']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('POST', '/health')[0], 405)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)
        self.assertEqual(self.request('BREW', '/health')[0], 405)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw='x' * (1024 * 1024 + 1))[0], 413)
        raw = '{"value":"' + 'x' * (1024 * 1024 - 12) + '"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/limit', raw=raw)[0], 201)

    def test_concurrency(self):
        def put(i):
            return self.request('PUT', f'/v1/kv/k{i:03}', {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(60))), [201] * 60)
        expected = [f'k{i:03}' for i in range(60)]
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], expected)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], expected)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda i: self.request('PUT', '/v1/kv/shared', {'value': i})[0], range(30)))
        self.assertEqual(results.count(201), 1)
        self.assertEqual(results.count(200), 29)
        self.assertEqual(len(json.loads(self.data.read_text())['entries']), 61)


if __name__ == '__main__':
    unittest.main()
