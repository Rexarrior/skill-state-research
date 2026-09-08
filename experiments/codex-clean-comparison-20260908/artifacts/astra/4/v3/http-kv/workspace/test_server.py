"""Integration tests using only the Python standard library."""
import concurrent.futures
import http.client
import json
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import quote


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.directory.name) / 'data.json'
        self.process = None
        self.start()

    def start(self):
        self.diagnostics = tempfile.TemporaryFile(mode='w+b', dir=self.directory.name)
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('server.py')),
             '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=self.diagnostics, text=True)
        self.assertTrue(select.select([self.process.stdout], [], [], 10)[0], 'Startup timed out')
        line = self.process.stdout.readline()
        self.assertRegex(line, r'^LISTENING [0-9]+\n$')
        self.port = int(line.split()[1])

    def stop(self):
        if self.process is not None:
            self.process.terminate()
            try:
                output, _ = self.process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.communicate()
                self.fail('SIGTERM did not shut down cleanly')
            self.assertEqual(self.process.returncode, 0)
            self.assertEqual(output, '')
            self.process = None
            self.diagnostics.close()

    def tearDown(self):
        try:
            self.stop()
        finally:
            self.directory.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            payload = json.dumps(body).encode() if body is not None else raw
            connection.request(method, path, body=payload, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_keys_and_restart(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        key = 'snow ☃ + space'
        path = '/v1/kv/' + quote(key, safe='')
        value = {'nested': [None, True, 1, 1.5, 'hello']}
        self.assertEqual(self.request('PUT', path, {'value': value}), (201, {'key': key, 'value': value}))
        self.assertEqual(self.request('PUT', path, {'value': False})[0], 200)
        self.assertEqual(self.request('PUT', '/v1/kv/a', {'value': None})[0], 201)
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['a', key]}))
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', path), (200, {'key': key, 'value': False}))
        self.assertEqual(self.request('DELETE', path), (204, None))
        self.assertEqual(self.request('DELETE', path)[0], 404)
        self.assertEqual(self.request('GET', path)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', path)[0], 404)

    def test_expiration_across_restart(self):
        for key in ['get', 'delete', 'replace', 'offline']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key,
                                          {'value': 1, 'ttl_seconds': 0.5})[0], 201)
        self.stop()
        time.sleep(0.6)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/get')[0], 404)
        self.assertEqual(self.request('DELETE', '/v1/kv/delete')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': []}))
        self.assertEqual(self.request('PUT', '/v1/kv/replace', {'value': 2})[0], 201)
        self.request('PUT', '/v1/kv/live', {'value': 1, 'ttl_seconds': 0.1})
        time.sleep(0.2)
        self.assertEqual(self.request('GET', '/v1/kv/live')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['replace']}))

    def test_invalid_requests(self):
        for raw in [b'{', b'[]', b'null', b'{}', b'{"value":NaN}',
                    b'{"value":1e999}', b'{"value":0,"extra":1}', b'\xff']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/a', raw=raw)[0], 400)
        for ttl in [None, True, False, 0, -1, '1', [], {}, float('inf'), float('nan'), 10**400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request('PUT', '/v1/kv/a', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ['', '%FF', '%', '%GG', 'a/b', 'a%2Fb']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('POST', '/v1/kv/a', {'value': 1})[0], 405)
        self.assertEqual(self.request('PATCH', '/health')[0], 405)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)
        self.assertEqual(self.request('GET', '/health', headers={'Content-Length': str(1024*1024+1)})[0], 413)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw=b'', headers={'Content-Length': '-1'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw=b'', headers={'Transfer-Encoding': 'chunked'})[0], 400)

    def test_body_limit(self):
        payload = b'{"value":"' + b'x' * (1024*1024 - 12) + b'"}'
        self.assertEqual(len(payload), 1024*1024)
        self.assertEqual(self.request('PUT', '/v1/kv/large', raw=payload)[0], 201)
        self.assertEqual(self.request('PUT', '/v1/kv/large', raw=payload + b' ')[0], 413)

    def test_concurrent_persistence(self):
        def put(index):
            return self.request('PUT', '/v1/kv/k%03d' % index, {'value': index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(60))), [201] * 60)
        def replace(index):
            return self.request('PUT', '/v1/kv/shared', {'value': index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            statuses = list(pool.map(replace, range(24)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 23)
        self.stop()
        document = json.loads(self.data.read_text())
        self.assertEqual(len(document['entries']), 61)
        self.start()
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 61)
        for index in range(60):
            self.assertEqual(self.request('GET', '/v1/kv/k%03d' % index)[1]['value'], index)


if __name__ == '__main__':
    unittest.main()
