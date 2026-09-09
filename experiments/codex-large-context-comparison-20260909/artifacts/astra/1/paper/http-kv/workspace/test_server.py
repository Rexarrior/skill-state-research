import concurrent.futures
import http.client
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


class IntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.data = Path(self.tmp.name) / 'data.json'
        self.start()

    def start(self):
        self.log = open(Path(self.tmp.name) / 'stderr.log', 'ab')
        self.proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name('server.py')), '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)], stdout=subprocess.PIPE, stderr=self.log, text=True)
        line = self.proc.stdout.readline()
        self.assertTrue(line.startswith('LISTENING '), line)
        self.port = int(line.split()[1])

    def stop(self):
        self.proc.terminate()
        self.assertEqual(self.proc.wait(timeout=15), 0)
        self.proc.stdout.close()
        self.log.close()

    def tearDown(self):
        if self.proc.poll() is None:
            self.stop()
        self.tmp.cleanup()

    def request(self, method, path, obj=None, raw=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        body = raw if raw is not None else (json.dumps(obj) if obj is not None else None)
        connection.request(method, path, body, {'Content-Type': 'application/json'})
        response = connection.getresponse()
        status, content_type, data = response.status, response.getheader('Content-Type'), response.read()
        connection.close()
        self.assertEqual(content_type, 'application/json')
        return status, json.loads(data) if data else None

    def test_lifecycle_restart_and_expiry(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        self.assertEqual(self.request('PUT', '/v1/kv/a%20%E2%98%83', {'value': [None, True, {'x': 1}]} )[0], 201)
        self.assertEqual(self.request('PUT', '/v1/kv/z', {'value': 'old'})[0], 201)
        self.assertEqual(self.request('PUT', '/v1/kv/z', {'value': 'new'})[0], 200)
        self.assertEqual(self.request('PUT', '/v1/kv/exp', {'value': 42, 'ttl_seconds': .3})[0], 201)
        self.stop()
        time.sleep(.35)
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['a ☃', 'z']}))
        self.assertEqual(self.request('GET', '/v1/kv/z'), (200, {'key': 'z', 'value': 'new'}))
        self.assertEqual(self.request('GET', '/v1/kv/exp')[0], 404)
        self.assertEqual(self.request('DELETE', '/v1/kv/z'), (204, None))
        self.assertEqual(self.request('DELETE', '/v1/kv/z')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/exp', {'value': False})[0], 201)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/z')[0], 404)

    def test_validation(self):
        for raw in ['{', '[]', '{}', '{"value":NaN}', '{"value":1e999}', '{"value":1,"extra":2}']:
            self.assertEqual(self.request('PUT', '/v1/kv/x', raw=raw)[0], 400)
        for ttl in [0, -1, True, None, '2', [], {}]:
            self.assertEqual(self.request('PUT', '/v1/kv/x', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ['', '%2F', 'a/b', '%FF', '%zz']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw='x' * (1024 * 1024 + 1))[0], 413)
        self.assertEqual(self.request('POST', '/v1/kv/x')[0], 405)
        self.assertEqual(self.request('CUSTOM', '/v1/kv/x')[0], 405)
        self.assertEqual(self.request('GET', '/missing')[0], 404)

    def test_concurrent_persistence(self):
        def put(i):
            return self.request('PUT', f'/v1/kv/k{i:03}', {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(60))), [201] * 60)
        self.assertEqual(len(json.loads(self.data.read_text())['entries']), 60)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], [f'k{i:03}' for i in range(60)])
        for i in range(60):
            self.assertEqual(self.request('GET', f'/v1/kv/k{i:03}')[1]['value'], i)


if __name__ == '__main__':
    unittest.main()
