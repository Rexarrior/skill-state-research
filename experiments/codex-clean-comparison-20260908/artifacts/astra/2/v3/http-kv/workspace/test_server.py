"""Integration tests using only the Python standard library."""
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


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.temp.name) / 'state.json'
        self.process = None
        self.start()

    def start(self):
        self.log = open(Path(self.temp.name) / 'stderr.log', 'a+')
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('server.py')),
             '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=self.log, text=True)
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(5), 'Startup announcement timed out')
        line = self.process.stdout.readline()
        self.assertRegex(line, r'^LISTENING [0-9]+\n$')
        self.port = int(line.split()[1])

    def stop(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.assertEqual(self.process.wait(timeout=12), 0)
                self.assertEqual(self.process.stdout.read(), '')
            finally:
                if self.process.poll() is None:
                    self.process.kill()
                    self.process.wait()
                self.process.stdout.close()
                self.log.close()
                self.process = None

    def tearDown(self):
        try:
            self.stop()
        finally:
            self.temp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            if body is not None:
                raw = json.dumps(body).encode()
            connection.request(method, path, body=raw, headers=headers or {})
            response = connection.getresponse()
            payload = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            self.assertEqual(int(response.getheader('Content-Length')), len(payload))
            return response.status, json.loads(payload) if payload else None
        finally:
            connection.close()

    def test_crud_unicode_and_sort(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        values = [None, True, 1, 2.5, 'text', [1, {'a': False}], {'nested': [None]}]
        for value in values:
            self.assertEqual(self.request('PUT', '/v1/kv/a', {'value': value})[0],
                             201 if value is None else 200)
            self.assertEqual(self.request('GET', '/v1/kv/a'), (200, {'key': 'a', 'value': value}))
        self.assertEqual(self.request('PUT', '/v1/kv/%E9%9B%AA%20%2B%25', {'value': 7})[0], 201)
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['a', '雪 +%']}))
        self.assertEqual(self.request('DELETE', '/v1/kv/a'), (204, None))
        self.assertEqual(self.request('DELETE', '/v1/kv/a')[0], 404)
        self.assertEqual(self.request('GET', '/v1/kv/a')[0], 404)

    def test_validation(self):
        for raw in [b'', b'{', b'[]', b'null', b'{}', b'{"value": NaN}',
                    b'{"value": 1e999}', b'{"value":"\xff"}', b'{"value":1,"extra":2}']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/k', raw=raw)[0], 400)
        for ttl in [None, False, True, 0, -1, '1', [], {}, float('inf'), float('nan')]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request('PUT', '/v1/kv/k', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ['', '%2F', 'a/b', '%FF', '%', '%GG']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('POST', '/health')[0], 405)
        self.assertEqual(self.request('PATCH', '/v1/kv/a')[0], 405)
        self.assertEqual(self.request('DELETE', '/v1/keys')[0], 405)
        self.assertEqual(self.request('GET', '/missing')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/k', headers={'Content-Length': '1048577'})[0], 413)
        self.assertEqual(self.request('PUT', '/v1/kv/k', headers={'Content-Length': '-1'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/k', headers={'Transfer-Encoding': 'chunked'})[0], 400)
        raw = b'{"value":"' + b'x' * (1048576 - 12) + b'"}'
        self.assertEqual(len(raw), 1048576)
        self.assertEqual(self.request('PUT', '/v1/kv/large', raw=raw)[0], 201)

    def test_restart_and_expiry(self):
        self.request('PUT', '/v1/kv/forever', {'value': {'a': 1}})
        self.request('PUT', '/v1/kv/short', {'value': 2, 'ttl_seconds': 0.3})
        self.stop()
        time.sleep(0.35)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/forever')[1]['value'], {'a': 1})
        self.assertEqual(self.request('GET', '/v1/kv/short')[0], 404)
        self.assertNotIn('short', json.loads(self.data.read_text())['entries'])
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 3, 'ttl_seconds': 0.05})[0], 201)
        time.sleep(0.08)
        self.assertEqual(self.request('DELETE', '/v1/kv/short')[0], 404)
        self.request('PUT', '/v1/kv/replaced', {'value': 1, 'ttl_seconds': 0.05})
        self.request('PUT', '/v1/kv/replaced', {'value': 2})
        time.sleep(0.08)
        self.assertEqual(self.request('GET', '/v1/kv/replaced')[0], 200)

    def test_concurrent_writes_persist(self):
        def put(index):
            return self.request('PUT', '/v1/kv/k' + str(index), {'value': index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(put, range(40))), [201] * 40)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(lambda _: self.request('PUT', '/v1/kv/shared', {'value': 1})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)
        self.stop()
        self.assertEqual(len(json.loads(self.data.read_text())['entries']), 41)
        self.start()
        for i in range(40):
            self.assertEqual(self.request('GET', '/v1/kv/k' + str(i))[1]['value'], i)


if __name__ == '__main__':
    unittest.main()
