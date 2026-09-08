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


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.temp.name) / 'data.json'
        self.start()

    def start(self):
        self.errors = open(Path(self.temp.name) / 'stderr.log', 'a')
        self.proc = subprocess.Popen([sys.executable, 'server.py', '--host', '127.0.0.1',
                                      '--port', '0', '--data', str(self.data)],
                                     cwd=Path(__file__).parent, stdout=subprocess.PIPE,
                                     stderr=self.errors, text=True)
        line = self.proc.stdout.readline().strip()
        self.assertRegex(line, r'^LISTENING [0-9]+$')
        self.port = int(line.split()[1])

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=15)
        self.assertEqual(self.proc.returncode, 0)
        self.assertEqual(self.proc.stdout.read(), '')
        self.proc.stdout.close()
        self.errors.close()

    def tearDown(self):
        if self.proc.poll() is None:
            self.stop()
        self.temp.cleanup()

    def request(self, method, path, obj=None, raw=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            body = raw if raw is not None else (json.dumps(obj) if obj is not None else None)
            conn.request(method, path, body=body)
            response = conn.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(data) if data else None
        finally:
            conn.close()

    def test_crud_restart(self):
        path = '/v1/kv/' + quote('hello 世界', safe='')
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        self.assertEqual(self.request('PUT', path, {'value': [None, True, {'x': 2}]} )[0], 201)
        self.assertEqual(self.request('PUT', path, {'value': 'updated'})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', path), (200, {'key': 'hello 世界', 'value': 'updated'}))
        self.assertEqual(self.request('DELETE', path), (204, None))
        self.assertEqual(self.request('DELETE', path)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', path)[0], 404)

    def test_ttl(self):
        self.request('PUT', '/v1/kv/short', {'value': 1, 'ttl_seconds': .2})
        self.stop()
        time.sleep(.25)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/short')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1], {'keys': []})
        self.assertEqual(self.request('DELETE', '/v1/kv/short')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 2})[0], 201)
        self.request('PUT', '/v1/kv/reset', {'value': 1, 'ttl_seconds': .1})
        self.request('PUT', '/v1/kv/reset', {'value': 2})
        time.sleep(.15)
        self.assertEqual(self.request('GET', '/v1/kv/reset')[0], 200)

    def test_invalid_requests(self):
        for raw in ['{', '[]', 'null', '{}', '{"value": NaN}', '{"value": 1e999}',
                    '{"value":1,"ttl_seconds":true}', '{"value":1,"ttl_seconds":null}',
                    '{"value":1,"ttl_seconds":0}', '{"value":1,"ttl_seconds":-1}',
                    '{"value":1,"ttl_seconds":1e999}']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/a', raw=raw)[0], 400)
        for path in ['/v1/kv/', '/v1/kv/a%2Fb', '/v1/kv/a/b', '/v1/kv/%FF', '/v1/kv/%ZZ']:
            self.assertEqual(self.request('PUT', path, {'value': 1})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw='x' * (1024 * 1024 + 1))[0], 413)
        self.assertEqual(self.request('POST', '/v1/keys')[0], 405)
        self.assertEqual(self.request('BREW', '/health')[0], 405)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)

    def test_concurrent_persistence(self):
        def put(index):
            return self.request('PUT', f'/v1/kv/k{index:03}', {'value': index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(60))), [201] * 60)
        expected = [f'k{i:03}' for i in range(60)]
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], expected)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], expected)
        self.assertEqual(len(json.loads(self.data.read_text())['entries']), 60)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.request('PUT', '/v1/kv/shared', {'value': 1})[0], range(20)))
        self.assertEqual(results.count(201), 1)
        self.assertEqual(results.count(200), 19)


if __name__ == '__main__':
    unittest.main()
