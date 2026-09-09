import concurrent.futures
import http.client
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import quote


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=pathlib.Path(__file__).parent)
        self.data = pathlib.Path(self.temp.name) / 'data.json'
        self.start()

    def start(self):
        self.logs = tempfile.TemporaryFile(mode='w+', dir=self.temp.name)
        self.process = subprocess.Popen(
            [sys.executable, str(pathlib.Path(__file__).with_name('server.py')),
             '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=self.logs, text=True)
        line = self.process.stdout.readline()
        if not line.startswith('LISTENING '):
            self.process.wait(timeout=8)
            self.logs.seek(0)
            diagnostics = self.logs.read()
            self.process.stdout.close()
            self.logs.close()
            self.temp.cleanup()
            self.fail('Server startup failed: ' + diagnostics)
        self.port = int(line.split()[1])

    def stop(self):
        self.process.terminate()
        self.assertEqual(self.process.wait(timeout=8), 0)
        self.assertEqual(self.process.stdout.read(), '')
        self.process.stdout.close()
        self.logs.close()

    def tearDown(self):
        if self.process.poll() is None:
            self.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=8)
        try:
            connection.request(method, path, body=raw if raw is not None else
                               (json.dumps(body) if body is not None else None),
                               headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_restart_and_order(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        for key, value in [('z', None), ('a b☃', {'nested': [True, 3, 'é']})]:
            path = '/v1/kv/' + quote(key, safe='')
            self.assertEqual(self.request('PUT', path, {'value': value})[0], 201)
            self.assertEqual(self.request('GET', path), (200, {'key': key, 'value': value}))
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['a b☃', 'z']}))
        self.assertEqual(self.request('PUT', '/v1/kv/z', {'value': 4})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/z')[1]['value'], 4)
        self.assertEqual(self.request('DELETE', '/v1/kv/z'), (204, None))
        self.assertEqual(self.request('DELETE', '/v1/kv/z')[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/z')[0], 404)

    def test_expiration(self):
        self.request('PUT', '/v1/kv/expire', {'value': 1, 'ttl_seconds': 0.2})
        self.request('PUT', '/v1/kv/reset', {'value': 1, 'ttl_seconds': 0.2})
        self.request('PUT', '/v1/kv/reset', {'value': 2})
        self.stop()
        time.sleep(0.25)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/expire')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], ['reset'])
        self.assertEqual(self.request('PUT', '/v1/kv/expire', {'value': 2, 'ttl_seconds': 0.1})[0], 201)
        time.sleep(0.15)
        self.assertEqual(self.request('DELETE', '/v1/kv/expire')[0], 404)
        self.request('PUT', '/v1/kv/persist', {'value': True})
        self.assertNotIn('expire', json.loads(self.data.read_text()))

    def test_invalid_requests(self):
        for raw in ['{', '[]', 'null', '{}', '{"value": NaN}', '{"value": 1e999}',
                    '{"value":"\\ud800"}', '{"value": 1, "extra": 2}']:
            self.assertEqual(self.request('PUT', '/v1/kv/k', raw=raw)[0], 400, raw)
        for ttl in [0, -1, True, None, '1', [], {}]:
            self.assertEqual(self.request('PUT', '/v1/kv/k', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ['', 'a/b', 'a%2Fb', '%FF', '%', '%GG', '%ED%A0%80']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('GET', '/missing')[0], 404)
        self.assertEqual(self.request('POST', '/v1/kv/k', {})[0], 405)
        self.assertEqual(self.request('PUT', '/health', {})[0], 405)
        self.assertEqual(self.request('WHATEVER', '/health')[0], 405)
        self.assertEqual(self.request('PUT', '/v1/kv/k', raw='x' * (1024 * 1024 + 1))[0], 413)
        self.assertEqual(self.request('PUT', '/v1/kv/k', raw='', headers={'Content-Length': '-1'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/k', raw='', headers={'Transfer-Encoding': 'chunked'})[0], 400)

    def test_concurrency(self):
        def put(i):
            return self.request('PUT', '/v1/kv/key' + str(i), {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(40))), [201] * 40)
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 40)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            statuses = list(pool.map(lambda i: self.request('PUT', '/v1/kv/shared', {'value': i})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)
        self.stop()
        self.start()
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 41)


if __name__ == '__main__':
    unittest.main()
