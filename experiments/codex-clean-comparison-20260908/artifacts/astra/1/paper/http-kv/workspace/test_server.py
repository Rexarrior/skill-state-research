import concurrent.futures
import http.client
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.data = Path(self.temp.name) / 'state.json'
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('server.py')), '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = self.process.stdout.readline()
        self.assertTrue(line.startswith('LISTENING '), line)
        self.port = int(line.split()[1])

    def stop(self):
        self.process.terminate()
        self.assertEqual(self.process.wait(timeout=10), 0)
        self.assertEqual(self.process.stdout.read(), '')
        self.process.stdout.close()

    def tearDown(self):
        if self.process.poll() is None:
            self.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, raw=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        connection.request(method, path, body=raw if raw is not None else (json.dumps(body) if body is not None else None))
        response = connection.getresponse()
        payload = response.read()
        self.assertEqual(response.getheader('Content-Type'), 'application/json')
        result = response.status, json.loads(payload) if payload else None
        connection.close()
        return result

    def test_api_restart_and_expiration(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        value = {'nested': [None, True, 42, 'hello']}
        self.assertEqual(self.request('PUT', '/v1/kv/a%20%C3%A9', {'value': value})[0], 201)
        self.assertEqual(self.request('GET', '/v1/kv/a%20%C3%A9'), (200, {'key': 'a é', 'value': value}))
        self.assertEqual(self.request('PUT', '/v1/kv/z', {'value': 1, 'ttl_seconds': 0.2})[0], 201)
        self.stop()
        time.sleep(0.25)
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['a é']}))
        self.assertEqual(self.request('GET', '/v1/kv/z')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/a%20%C3%A9', {'value': False})[0], 200)
        self.assertEqual(self.request('DELETE', '/v1/kv/a%20%C3%A9'), (204, None))
        self.assertEqual(self.request('DELETE', '/v1/kv/a%20%C3%A9')[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys')[1], {'keys': []})

    def test_validation(self):
        for raw in ['{', '[]', '{}', '{"value": NaN}', '{"value": 1e999}', '{"value":0,"extra":1}']:
            self.assertEqual(self.request('PUT', '/v1/kv/x', raw=raw)[0], 400)
        for ttl in [0, -1, True, None, '1', float('inf')]:
            self.assertEqual(self.request('PUT', '/v1/kv/x', {'value': 0, 'ttl_seconds': ttl})[0], 400)
        for key in ['', 'a/b', 'a%2Fb', '%FF', '%xy', '%']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('POST', '/v1/kv/x')[0], 405)
        self.assertEqual(self.request('PATCH', '/health')[0], 405)
        self.assertEqual(self.request('GET', '/missing')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw=' ' * (1024 * 1024 + 1))[0], 413)

    def test_concurrency_and_ttl_reset(self):
        def put(i):
            return self.request('PUT', f'/v1/kv/{i:03}', {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(40))), [201] * 40)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], [f'{i:03}' for i in range(40)])
        self.request('PUT', '/v1/kv/ttl', {'value': 1, 'ttl_seconds': 0.1})
        self.request('PUT', '/v1/kv/ttl', {'value': 2})
        time.sleep(0.15)
        self.assertEqual(self.request('GET', '/v1/kv/ttl')[1]['value'], 2)
        self.request('PUT', '/v1/kv/expired', {'value': 1, 'ttl_seconds': 0.05})
        time.sleep(0.08)
        self.assertEqual(self.request('PUT', '/v1/kv/expired', {'value': 2})[0], 201)


if __name__ == '__main__':
    unittest.main()
