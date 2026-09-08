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
        self.process = None
        self.start()

    def start(self):
        self.log = open(Path(self.temp.name) / 'stderr.log', 'a+')
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('server.py')),
             '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=self.log, text=True)
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r'^LISTENING [0-9]+$')
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
        self.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            payload = raw if raw is not None else (json.dumps(body) if body is not None else None)
            conn.request(method, path, body=payload, headers=headers or {})
            response = conn.getresponse()
            content = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(content) if content else None
        finally:
            conn.close()

    def test_crud_keys_and_json_values(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        for key, value in [('z', None), ('hello world', [1, True, {'x': '雪'}]), ('a', 12)]:
            path = '/v1/kv/' + quote(key, safe='')
            self.assertEqual(self.request('PUT', path, {'value': value})[0], 201)
            self.assertEqual(self.request('GET', path), (200, {'key': key, 'value': value}))
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['a', 'hello world', 'z']}))
        self.assertEqual(self.request('PUT', '/v1/kv/a', {'value': False})[0], 200)
        self.assertEqual(self.request('DELETE', '/v1/kv/a'), (204, None))
        self.assertEqual(self.request('DELETE', '/v1/kv/a')[0], 404)
        self.assertEqual(self.request('GET', '/v1/kv/a')[0], 404)

    def test_persistence_and_expiration(self):
        self.request('PUT', '/v1/kv/permanent', {'value': {'nested': [1, 2]}})
        self.request('PUT', '/v1/kv/temporary', {'value': 2, 'ttl_seconds': 0.3})
        self.stop()
        time.sleep(0.35)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/permanent')[1]['value'], {'nested': [1, 2]})
        self.assertEqual(self.request('GET', '/v1/kv/temporary')[0], 404)
        self.assertNotIn('temporary', json.loads(self.data.read_text())['entries'])
        self.request('PUT', '/v1/kv/temporary', {'value': 1, 'ttl_seconds': 0.05})
        time.sleep(0.08)
        self.assertEqual(self.request('PUT', '/v1/kv/temporary', {'value': 3})[0], 201)
        self.request('PUT', '/v1/kv/dead', {'value': 1, 'ttl_seconds': 0.05})
        time.sleep(0.08)
        self.assertEqual(self.request('DELETE', '/v1/kv/dead')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], ['permanent', 'temporary'])
        self.request('DELETE', '/v1/kv/permanent')
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/permanent')[0], 404)

    def test_invalid_requests(self):
        invalid = ['{', '[]', 'null', '{}', '{"value": NaN}', '{"value": 1e999}',
                   '{"value": 0, "extra": 1}', '{"value": 0, "ttl_seconds": 1e999}']
        invalid += [json.dumps({'value': 0, 'ttl_seconds': ttl})
                    for ttl in [None, True, False, 0, -1, '1', [], {}, 10 ** 400]]
        for raw in invalid:
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/x', raw=raw)[0], 400)
        for key in ['', 'a/b', 'a%2Fb', '%ff', '%', '%GG', '%ED%A0%80']:
            with self.subTest(key=key):
                self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw=b'\xff')[0], 400)
        for method in ['POST', 'PATCH', 'OPTIONS', 'CUSTOM']:
            self.assertEqual(self.request(method, '/v1/kv/x')[0], 405)
        self.assertEqual(self.request('GET', '/no-such-route')[0], 404)
        self.assertEqual(self.request('PUT', '/health', {'value': 1})[0], 405)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw='{}',
                                      headers={'Transfer-Encoding': 'chunked'})[0], 400)

    def test_body_limit(self):
        # Exactly 1 MiB is accepted; oversized requests are rejected by headers.
        raw = '{"value":"' + 'x' * (1024 * 1024 - 12) + '"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/large', raw=raw)[0], 201)
        self.assertEqual(self.request('PUT', '/v1/kv/large', raw='',
                                      headers={'Content-Length': str(1024 * 1024 + 1)})[0], 413)

    def test_concurrent_writes(self):
        def write(i):
            return self.request('PUT', '/v1/kv/key' + str(i), {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(write, range(32))), [201] * 32)
        def replace(i):
            return self.request('PUT', '/v1/kv/shared', {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(replace, range(16)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 15)
        self.stop()
        self.start()
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 33)
        for i in range(32):
            self.assertEqual(self.request('GET', '/v1/kv/key' + str(i))[1]['value'], i)


if __name__ == '__main__':
    unittest.main()
