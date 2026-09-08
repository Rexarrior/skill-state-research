"""End-to-end tests using only Python's standard library."""
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
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'state.json'
        self.start()
        self.addCleanup(self.stop)

    def start(self):
        self.errors = tempfile.TemporaryFile()
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('server.py')),
             '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=self.errors, text=True)
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(5):
                self.process.kill()
                self.process.wait()
                self.fail('Server did not announce its port')
        line = self.process.stdout.readline()
        self.assertRegex(line, r'^LISTENING [0-9]+\n$')
        self.port = int(line.split()[1])

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
            self.fail('SIGTERM did not stop the server')
        self.assertEqual(self.process.returncode, 0)
        self.assertEqual(self.process.stdout.read(), '')
        self.process.stdout.close()
        self.errors.close()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=8)
        try:
            payload = raw if raw is not None else (json.dumps(body) if body is not None else None)
            connection.request(method, path, body=payload, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_and_sorted_unicode_keys(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': []}))
        keys = ['z', 'a space', 'é', '雪', 'a+b', '%']
        for key in keys:
            path = '/v1/kv/' + quote(key, safe='')
            value = {'nested': [None, True, 4, 1.5, 'text']}
            self.assertEqual(self.request('PUT', path, {'value': value})[0], 201)
            self.assertEqual(self.request('GET', path), (200, {'key': key, 'value': value}))
            self.assertEqual(self.request('PUT', path, {'value': None})[0], 200)
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': sorted(keys)}))
        self.assertEqual(self.request('DELETE', '/v1/kv/z'), (204, None))
        self.assertEqual(self.request('DELETE', '/v1/kv/z')[0], 404)
        self.assertEqual(self.request('GET', '/v1/kv/z')[0], 404)

    def test_validation(self):
        for raw in ['{', '[]', 'null', '{}', '{"value": NaN}', '{"value": 1e999}', b'\xff']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/a', raw=raw)[0], 400)
        for ttl in [None, False, True, 0, -1, '1', [], {}, float('inf'), float('nan')]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request('PUT', '/v1/kv/a', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ['', 'a/b', 'a%2Fb', '%FF', '%', '%GG', '%ED%A0%80']:
            with self.subTest(key=key):
                self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        for method in ['POST', 'PATCH', 'OPTIONS', 'SOMETHING']:
            self.assertEqual(self.request(method, '/v1/kv/a')[0], 405)
        self.assertEqual(self.request('PUT', '/health', {'value': 1})[0], 405)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw='x', headers={'Content-Length': '-1'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw='', headers={'Transfer-Encoding': 'chunked'})[0], 400)

    def test_body_limit(self):
        raw = '{"value":"' + 'x' * (1024 * 1024 - 12) + '"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/large', raw=raw)[0], 201)
        # Send headers only: rejection must not wait for an oversized body.
        self.assertEqual(self.request('PUT', '/v1/kv/large', raw='', headers={'Content-Length': str(1024 * 1024 + 1)})[0], 413)

    def test_restart_expiration_and_ttl_removal(self):
        self.request('PUT', '/v1/kv/keep', {'value': [1, 2]})
        self.request('PUT', '/v1/kv/gone', {'value': 1, 'ttl_seconds': 0.2})
        self.request('PUT', '/v1/kv/reset', {'value': 1, 'ttl_seconds': 0.2})
        self.request('PUT', '/v1/kv/reset', {'value': 2})
        self.stop()
        time.sleep(0.25)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/keep'), (200, {'key': 'keep', 'value': [1, 2]}))
        self.assertEqual(self.request('GET', '/v1/kv/gone')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1], {'keys': ['keep', 'reset']})
        self.assertNotIn('gone', json.loads(self.data.read_text())['entries'])
        self.assertEqual(self.request('PUT', '/v1/kv/gone', {'value': 3})[0], 201)
        self.request('PUT', '/v1/kv/short', {'value': 1, 'ttl_seconds': 0.05})
        time.sleep(0.08)
        self.assertEqual(self.request('DELETE', '/v1/kv/short')[0], 404)
        self.request('DELETE', '/v1/kv/keep')
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/keep')[0], 404)

    def test_concurrent_writes_and_atomic_snapshots(self):
        def write(index):
            return self.request('PUT', f'/v1/kv/key{index:03}', {'value': index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(write, index) for index in range(60)]
            while not all(f.done() for f in futures):
                snapshot = json.loads(self.data.read_text())
                self.assertEqual(snapshot['version'], 1)
                time.sleep(0.002)
            self.assertEqual([f.result() for f in futures], [201] * 60)
            statuses = list(pool.map(lambda i: self.request('PUT', '/v1/kv/shared', {'value': i})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)
        self.stop()
        self.start()
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 61)
        for index in range(60):
            self.assertEqual(self.request('GET', f'/v1/kv/key{index:03}')[1]['value'], index)


if __name__ == '__main__':
    unittest.main()
