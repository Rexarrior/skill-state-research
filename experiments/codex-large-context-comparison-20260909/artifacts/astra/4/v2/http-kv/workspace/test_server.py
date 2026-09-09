"""Integration tests using real HTTP requests and server processes."""
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

ROOT = Path(__file__).resolve().parent


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=ROOT)
        self.data = Path(self.directory.name) / 'data.json'
        self.start()

    def start(self):
        self.log = open(Path(self.directory.name) / 'stderr.log', 'ab')
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / 'server.py'), '--host', '127.0.0.1',
             '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=self.log, text=True, cwd=ROOT)
        line = self.process.stdout.readline()
        self.assertRegex(line, r'^LISTENING [0-9]+\n$')
        self.port = int(line.split()[1])

    def stop(self):
        self.process.terminate()
        output, _ = self.process.communicate(timeout=15)
        self.log.close()
        self.assertEqual(self.process.returncode, 0)
        self.assertEqual(output, '')

    def tearDown(self):
        if self.process.poll() is None:
            self.stop()
        self.directory.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        payload = json.dumps(body).encode() if raw is None and body is not None else raw
        try:
            connection.request(method, path, body=payload, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            if response.status == 204:
                self.assertEqual(data, b'')
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_unicode_and_sorting(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        keys = ['z', 'a space', '日本語', '%literal', 'a']
        for key in keys:
            path = '/v1/kv/' + quote(key, safe='')
            value = {'nested': [None, True, 3, 2.5, 'text']}
            self.assertEqual(self.request('PUT', path, {'value': value})[0], 201)
            self.assertEqual(self.request('GET', path), (200, {'key': key, 'value': value}))
            self.assertEqual(self.request('PUT', path, {'value': None})[0], 200)
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': sorted(keys)}))
        self.assertEqual(self.request('DELETE', '/v1/kv/z'), (204, None))
        self.assertEqual(self.request('DELETE', '/v1/kv/z')[0], 404)
        self.assertEqual(self.request('GET', '/v1/kv/z')[0], 404)

    def test_validation(self):
        for path in ['/v1/kv/', '/v1/kv/a/b', '/v1/kv/a%2Fb', '/v1/kv/%FF', '/v1/kv/%', '/v1/kv/%xx']:
            self.assertEqual(self.request('PUT', path, {'value': 1})[0], 400, path)
        for raw in [b'', b'{', b'[]', b'null', b'{}', b'{"value":NaN}', b'{"value":1e999}', b'\xff']:
            self.assertEqual(self.request('PUT', '/v1/kv/x', raw=raw)[0], 400, raw)
        for ttl in [None, False, True, 0, -1, '10', [], {}, float('inf'), float('nan')]:
            self.assertEqual(self.request('PUT', '/v1/kv/x', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        self.assertEqual(self.request('POST', '/v1/kv/x', {})[0], 405)
        self.assertEqual(self.request('PATCH', '/health', {})[0], 405)
        self.assertEqual(self.request('GET', '/missing')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw=b'{}', headers={'Content-Length': '-1'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw=b'{}', headers={'Transfer-Encoding': 'chunked'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/x', headers={'Content-Length': str(1024 * 1024 + 1)})[0], 413)
        payload = b'{"value":"' + b'a' * (1024 * 1024 - 12) + b'"}'
        self.assertEqual(len(payload), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/limit', raw=payload)[0], 201)

    def test_restart_and_expiry(self):
        self.request('PUT', '/v1/kv/permanent', {'value': [1, 2]})
        self.request('PUT', '/v1/kv/expired', {'value': 1, 'ttl_seconds': 0.2})
        self.request('PUT', '/v1/kv/reset', {'value': 1, 'ttl_seconds': 0.2})
        self.request('PUT', '/v1/kv/reset', {'value': 2})
        self.stop()
        time.sleep(0.25)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/expired')[0], 404)
        self.assertEqual(self.request('DELETE', '/v1/kv/expired')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1], {'keys': ['permanent', 'reset']})
        self.assertEqual(self.request('GET', '/v1/kv/permanent')[1]['value'], [1, 2])
        self.assertEqual(self.request('GET', '/v1/kv/reset')[1]['value'], 2)
        self.assertNotIn('expired', json.loads(self.data.read_text())['entries'])
        self.assertEqual(self.request('PUT', '/v1/kv/expired', {'value': 3})[0], 201)
        self.request('PUT', '/v1/kv/short', {'value': 1, 'ttl_seconds': 0.05})
        time.sleep(0.08)
        self.assertEqual(self.request('GET', '/v1/kv/short')[0], 404)
        self.assertNotIn('short', self.request('GET', '/v1/keys')[1]['keys'])

    def test_concurrency_and_crash_durability(self):
        def put(index):
            return self.request('PUT', '/v1/kv/k' + str(index), {'value': index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(60))), [201] * 60)
            statuses = list(pool.map(lambda _: self.request('PUT', '/v1/kv/shared', {'value': 1})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)
        self.process.kill()
        self.process.communicate(timeout=5)
        self.log.close()
        self.start()
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 61)
        for index in range(60):
            self.assertEqual(self.request('GET', '/v1/kv/k' + str(index))[1]['value'], index)


if __name__ == '__main__':
    unittest.main()
