import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.data = Path(self.tmp.name) / 'state.json'
        self.start()

    def start(self):
        self.log = tempfile.TemporaryFile(mode='w+b', dir=self.tmp.name)
        self.proc = subprocess.Popen([sys.executable, 'server.py', '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)], stdout=subprocess.PIPE, stderr=self.log, text=True, cwd=Path(__file__).resolve().parent)
        self.assertTrue(select.select([self.proc.stdout], [], [], 5)[0], 'Startup timed out')
        line = self.proc.stdout.readline().strip()
        self.assertRegex(line, r'^LISTENING \d+$')
        self.port = int(line.split()[1])

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            self.fail('Shutdown timed out')
        self.assertEqual(self.proc.returncode, 0)
        self.assertEqual(self.proc.stdout.read(), '')
        self.proc.stdout.close()
        self.log.close()

    def tearDown(self):
        if self.proc.poll() is None:
            self.stop()
        self.tmp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            payload = json.dumps(body).encode() if body is not None else raw
            conn.request(method, path, payload, headers or {})
            response = conn.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(data) if data else None
        finally:
            conn.close()

    def test_crud_and_restart(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        key = '/v1/kv/caf%C3%A9%20tea'
        value = {'a': [None, True, 42, '☃']}
        self.assertEqual(self.request('PUT', key, {'value': value})[0], 201)
        self.assertEqual(self.request('GET', key), (200, {'key': 'café tea', 'value': value}))
        self.assertEqual(self.request('PUT', key, {'value': None})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', key), (200, {'key': 'café tea', 'value': None}))
        self.assertEqual(self.request('DELETE', key), (204, None))
        self.assertEqual(self.request('DELETE', key)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', key)[0], 404)

    def test_expiration(self):
        self.request('PUT', '/v1/kv/short', {'value': 1, 'ttl_seconds': .2})
        self.request('PUT', '/v1/kv/clear', {'value': 1, 'ttl_seconds': .2})
        self.request('PUT', '/v1/kv/clear', {'value': 2})
        self.request('PUT', '/v1/kv/live', {'value': 3, 'ttl_seconds': 60})
        self.stop()
        time.sleep(.25)
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['clear', 'live']}))
        self.assertEqual(self.request('GET', '/v1/kv/short')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 4, 'ttl_seconds': .05})[0], 201)
        time.sleep(.08)
        self.assertEqual(self.request('DELETE', '/v1/kv/short')[0], 404)
        self.assertNotIn('short', json.loads(self.data.read_text())['entries'])

    def test_validation(self):
        for raw in [b'', b'{', b'[]', b'null', b'{}', b'{"value": NaN}', b'{"value": 1e999}', b'{"value":"\xff"}']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/a', raw=raw)[0], 400)
        for ttl in [None, True, False, 0, -1, '1', [], {}, float('inf'), float('nan'), 10**400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request('PUT', '/v1/kv/a', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ['', 'a/b', 'a%2fb', '%FF', '%', '%GG', '%ED%A0%80']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('POST', '/v1/kv/a', {})[0], 405)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)
        self.assertTrue(400 <= self.request('BREW', '/health')[0] < 500)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw=b'x' * (1024 * 1024 + 1))[0], 413)
        raw = b'{"value":"' + b'x' * (1024 * 1024 - 12) + b'"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/big', raw=raw)[0], 201)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw=b'', headers={'Content-Length': '-1'})[0], 400)

    def test_concurrent_persistence(self):
        def put(i):
            return self.request('PUT', f'/v1/kv/key{i:03}', {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(60))), [201] * 60)
        expected = [f'key{i:03}' for i in range(60)]
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], expected)
        self.assertEqual(sorted(json.loads(self.data.read_text())['entries']), expected)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(lambda i: self.request('PUT', '/v1/kv/shared', {'value': i})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)
        self.stop()
        self.start()
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 61)


if __name__ == '__main__':
    unittest.main()
