import concurrent.futures
import http.client
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = str(Path(self.directory.name) / 'data.json')
        self.start()

    def start(self):
        self.process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('server.py')), '--port', '0', '--data', self.data], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = self.process.stdout.readline().strip()
        self.assertTrue(line.startswith('LISTENING '), line)
        self.port = int(line.split()[1])

    def stop(self):
        self.process.terminate()
        self.assertEqual(self.process.wait(timeout=15), 0)
        self.assertEqual(self.process.stdout.read(), '')
        self.process.stdout.close()

    def tearDown(self):
        if self.process.poll() is None:
            self.stop()
        self.directory.cleanup()

    def request(self, method, path, data=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        body = raw if raw is not None else (json.dumps(data) if data is not None else None)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        content = response.read()
        self.assertEqual(response.getheader('Content-Type'), 'application/json')
        status = response.status
        connection.close()
        return status, json.loads(content) if content else None

    def test_crud_restart_and_expiry(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        key = '/v1/kv/hello%20%E2%98%83'
        self.assertEqual(self.request('PUT', key, {'value': [None, True, {'x': 3}]} )[0], 201)
        self.assertEqual(self.request('PUT', key, {'value': 'persist'})[0], 200)
        self.request('PUT', '/v1/kv/expired', {'value': 1, 'ttl_seconds': .2})
        self.stop()
        time.sleep(.25)
        self.start()
        self.assertEqual(self.request('GET', key), (200, {'key': 'hello ☃', 'value': 'persist'}))
        self.assertEqual(self.request('GET', '/v1/kv/expired')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], ['hello ☃'])
        self.assertEqual(self.request('DELETE', key), (204, None))
        self.assertEqual(self.request('DELETE', key)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys')[1], {'keys': []})

    def test_validation(self):
        for body in ['{', '[]', '{}', '{"value":NaN}', '{"value":1e999}', '{"value":0,"ttl_seconds":null}', '{"value":0,"ttl_seconds":true}', '{"value":0,"ttl_seconds":0}', '{"value":0,"ttl_seconds":-1}', '{"value":0,"ttl_seconds":1e999}']:
            with self.subTest(body=body):
                self.assertEqual(self.request('PUT', '/v1/kv/a', raw=body)[0], 400)
        for key in ['', 'a/b', 'a%2Fb', '%FF', '%xx']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('POST', '/v1/kv/a', {})[0], 405)
        self.assertEqual(self.request('PUT', '/health', {})[0], 405)
        self.assertEqual(self.request('GET', '/missing')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw='x' * (1024 * 1024 + 1))[0], 413)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw='{}', headers={'Content-Length': '-1'})[0], 400)

    def test_concurrency_and_ttl_reset(self):
        def write(i):
            return self.request('PUT', f'/v1/kv/k{i:03}', {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(write, range(40))), [201] * 40)
        keys = self.request('GET', '/v1/keys')[1]['keys']
        self.assertEqual(keys, [f'k{i:03}' for i in range(40)])
        self.request('PUT', '/v1/kv/reset', {'value': 1, 'ttl_seconds': .1})
        self.request('PUT', '/v1/kv/reset', {'value': 2})
        time.sleep(.15)
        self.assertEqual(self.request('GET', '/v1/kv/reset')[1]['value'], 2)
        self.request('PUT', '/v1/kv/short', {'value': 1, 'ttl_seconds': .1})
        time.sleep(.15)
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 2})[0], 201)
        self.stop()
        self.start()
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 42)


if __name__ == '__main__':
    unittest.main()
