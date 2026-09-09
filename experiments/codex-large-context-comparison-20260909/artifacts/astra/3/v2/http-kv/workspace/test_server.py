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
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.temp.name) / 'data.json'
        self.process = None
        self.start()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, 'server.py', '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)],
            cwd=Path(__file__).parent, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.assertTrue(select.select([self.process.stdout], [], [], 5)[0], 'Startup timed out')
        line = self.process.stdout.readline()
        self.assertRegex(line, r'^LISTENING [0-9]+\n$')
        self.port = int(line.split()[1])

    def stop(self):
        if self.process is not None:
            process, self.process = self.process, None
            process.terminate()
            try:
                self.assertEqual(process.wait(timeout=5), 0)
                self.assertEqual(process.stdout.read(), '')
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                process.stdout.close()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            connection.request(method, path, payload, headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_and_values(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        key = 'a space + ☃'
        path = '/v1/kv/' + quote(key, safe='')
        value = {'nested': [None, True, 1, 1.25, 'text']}
        self.assertEqual(self.request('PUT', path, {'value': value})[0], 201)
        self.assertEqual(self.request('GET', path), (200, {'key': key, 'value': value}))
        self.assertEqual(self.request('PUT', path, {'value': None})[0], 200)
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': [key]}))
        self.assertEqual(self.request('DELETE', path), (204, None))
        self.assertEqual(self.request('DELETE', path)[0], 404)
        self.assertEqual(self.request('GET', path)[0], 404)

    def test_replace_json_types(self):
        for value in [True, 1, 1.0, False, 0, 0.0]:
            self.request('PUT', '/v1/kv/type', {'value': value})
            result = self.request('GET', '/v1/kv/type')[1]['value']
            self.assertIs(type(result), type(value))
            saved = json.loads(self.data.read_text())['entries']['type']['value']
            self.assertIs(type(saved), type(value))

    def test_validation(self):
        for raw in [b'{', b'[]', b'null', b'{}', b'{"value":NaN}', b'{"value":1e999}', b'\xff']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/a', raw=raw)[0], 400)
        for ttl in [0, -1, None, True, '1', [], float('inf')]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request('PUT', '/v1/kv/a', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ['', '%FF', '%', '%2F', 'a/b', '%ED%A0%80']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('POST', '/v1/kv/a', {})[0], 405)
        self.assertEqual(self.request('PATCH', '/health')[0], 405)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw=b'x' * (1024 * 1024 + 1))[0], 413)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw=b'{}', headers={'Content-Length': '-1'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw=b'{}', headers={'Transfer-Encoding': 'chunked'})[0], 400)
        raw = b'{"value":"' + b'a' * (1024 * 1024 - 12) + b'"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/limit', raw=raw)[0], 201)

    def test_expiration_and_restart(self):
        self.request('PUT', '/v1/kv/permanent', {'value': 7})
        self.request('PUT', '/v1/kv/expired', {'value': 8, 'ttl_seconds': 0.15})
        time.sleep(0.2)
        self.assertEqual(self.request('GET', '/v1/kv/expired')[0], 404)
        self.assertEqual(self.request('DELETE', '/v1/kv/expired')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/expired', {'value': 9, 'ttl_seconds': 0.3})[0], 201)
        self.stop()
        time.sleep(0.35)
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['permanent']}))
        self.assertEqual(self.request('GET', '/v1/kv/permanent'), (200, {'key': 'permanent', 'value': 7}))
        self.assertNotIn('expired', json.loads(self.data.read_text())['entries'])
        self.request('PUT', '/v1/kv/permanent', {'value': 10, 'ttl_seconds': 0.1})
        self.request('PUT', '/v1/kv/permanent', {'value': 11})
        time.sleep(0.15)
        self.assertEqual(self.request('GET', '/v1/kv/permanent')[1]['value'], 11)

    def test_concurrent_persistence(self):
        def put(i):
            return self.request('PUT', '/v1/kv/key-' + str(i), {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(48))), [201] * 48)
        expected = sorted('key-' + str(i) for i in range(48))
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], expected)
        self.assertEqual(sorted(json.loads(self.data.read_text())['entries']), expected)
        # Durability must not depend on orderly shutdown.
        self.process.kill()
        self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process = None
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], expected)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(lambda i: self.request('PUT', '/v1/kv/shared', {'value': i})[0], range(24)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 23)


if __name__ == '__main__':
    unittest.main()
