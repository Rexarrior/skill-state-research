"""End-to-end tests using only the Python standard library."""
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

ROOT = Path(__file__).resolve().parent


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name) / 'state.json'
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.log = open(Path(self.directory.name) / 'stderr.log', 'ab')
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / 'server.py'), '--host', '127.0.0.1',
             '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=self.log)
        self.assertTrue(select.select([self.process.stdout], [], [], 5)[0], 'startup timeout')
        line = self.process.stdout.readline().decode()
        self.assertRegex(line, r'^LISTENING [0-9]+\n$')
        self.port = int(line.split()[1])

    def stop(self):
        if self.process is not None:
            process, self.process = self.process, None
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                self.fail('SIGTERM did not stop the service')
            finally:
                remaining = process.stdout.read()
                process.stdout.close()
                self.log.close()
            self.assertEqual(process.returncode, 0)
            self.assertEqual(remaining, b'', 'unexpected stdout diagnostics')

    def request(self, method, path, payload=None, raw=None, headers=None):
        body = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            if response.status == 204:
                self.assertEqual(data, b'')
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def put(self, key, value, **kwargs):
        return self.request('PUT', '/v1/kv/' + quote(key, safe=''), {'value': value, **kwargs})

    def test_crud_unicode_sorting_and_restart(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        key = 'snow 雪 % ? #'
        value = {'nested': [None, True, 3.25, 'hello']}
        self.assertEqual(self.put(key, value)[0], 201)
        self.assertEqual(self.put('z', 1)[0], 201)
        self.assertEqual(self.put('a', False)[0], 201)
        self.assertEqual(self.put('z', [1, 2])[0], 200)
        expected = sorted([key, 'a', 'z'])
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': expected}))
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/' + quote(key, safe='')),
                         (200, {'key': key, 'value': value}))
        self.assertEqual(self.request('DELETE', '/v1/kv/z'), (204, None))
        self.assertEqual(self.request('DELETE', '/v1/kv/z')[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/z')[0], 404)

    def test_ttl_and_replacement(self):
        self.put('expires', 1, ttl_seconds=0.25)
        self.put('reset', 2, ttl_seconds=0.25)
        self.put('reset', 3)
        self.stop()
        time.sleep(0.3)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/expires')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['reset']}))
        self.assertNotIn('expires', json.loads(self.data.read_text())['entries'])
        self.put('deleted', 1, ttl_seconds=0.02)
        time.sleep(0.04)
        self.assertEqual(self.request('DELETE', '/v1/kv/deleted')[0], 404)
        self.assertEqual(self.put('expires', 4)[0], 201)

    def test_validation(self):
        for body in [b'{', b'[]', b'null', b'{}', b'{"value":NaN}', b'{"value":Infinity}',
                     b'{"value":1e999}', b'{"value":"\xff"}', b'{"value":1,"extra":2}']:
            with self.subTest(body=body):
                self.assertEqual(self.request('PUT', '/v1/kv/key', raw=body)[0], 400)
        for ttl in [None, True, False, 0, -1, '2', [], {}, float('inf'), 10**400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.put('key', 1, ttl_seconds=ttl)[0], 400)
        for path in ['/v1/kv/', '/v1/kv/a/b', '/v1/kv/a%2Fb', '/v1/kv/%FF', '/v1/kv/%GG']:
            with self.subTest(path=path):
                self.assertEqual(self.request('GET', path)[0], 400)
        self.assertEqual(self.request('POST', '/health')[0], 405)
        self.assertEqual(self.request('PATCH', '/v1/kv/key')[0], 405)
        self.assertEqual(self.request('BREW', '/health')[0], 405)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/key')[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/key', raw=b'',
                                      headers={'Content-Length': '1048577'})[0], 413)
        self.assertEqual(self.request('PUT', '/v1/kv/key', raw=b'',
                                      headers={'Content-Length': '-1'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/key', raw=b'',
                                      headers={'Transfer-Encoding': 'chunked'})[0], 400)

    def test_exact_body_limit(self):
        body = b'{"value":"' + b'x' * (1024 * 1024 - 12) + b'"}'
        self.assertEqual(len(body), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/large', raw=body)[0], 201)

    def test_concurrent_writes(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.put(f'key-{i:02}', i)[0], range(40)))
        self.assertEqual(results, [201] * 40)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.put('shared', i)[0], range(20)))
        self.assertEqual(results.count(201), 1)
        self.assertEqual(results.count(200), 19)
        self.stop()
        self.start()
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 41)
        for i in range(40):
            self.assertEqual(self.request('GET', f'/v1/kv/key-{i:02}')[1]['value'], i)


if __name__ == '__main__':
    unittest.main()
