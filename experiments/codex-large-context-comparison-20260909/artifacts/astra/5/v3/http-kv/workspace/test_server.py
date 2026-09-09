"""End-to-end tests using a real server process and temporary data file."""
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
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'state.json'
        self.start()
        self.addCleanup(self.stop)

    def start(self):
        self.log = open(Path(self.temp.name) / 'stderr.log', 'a')
        self.proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name('server.py')),
                                      '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)],
                                     stdout=subprocess.PIPE, stderr=self.log, text=True)
        line = self.proc.stdout.readline().strip()
        self.assertRegex(line, r'^LISTENING [0-9]+$')
        self.port = int(line.split()[1])

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
                self.fail('SIGTERM failed to stop service')
        self.assertEqual(self.proc.returncode, 0)
        self.assertEqual(self.proc.stdout.read(), '')
        self.proc.stdout.close()
        self.log.close()

    def request(self, method, path, payload=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            body = raw if raw is not None else (json.dumps(payload) if payload is not None else None)
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_and_sorted_keys(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        for key in ['z', 'a space', 'é', 'a']:
            route = '/v1/kv/' + quote(key, safe='')
            value = {'nested': [None, True, 12, 'hello']}
            self.assertEqual(self.request('PUT', route, {'value': value})[0], 201)
            self.assertEqual(self.request('GET', route), (200, {'key': key, 'value': value}))
            self.assertEqual(self.request('PUT', route, {'value': False})[0], 200)
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': ['a', 'a space', 'z', 'é']}))
        self.assertEqual(self.request('DELETE', '/v1/kv/a'), (204, None))
        self.assertEqual(self.request('DELETE', '/v1/kv/a')[0], 404)
        self.assertEqual(self.request('GET', '/v1/kv/a')[0], 404)

    def test_restart_and_expiration(self):
        self.request('PUT', '/v1/kv/persistent', {'value': [1, 2]})
        self.request('PUT', '/v1/kv/expired', {'value': 1, 'ttl_seconds': .15})
        self.request('PUT', '/v1/kv/reset', {'value': 1, 'ttl_seconds': .15})
        self.request('PUT', '/v1/kv/reset', {'value': 2})
        self.stop()
        time.sleep(.2)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/persistent')[1]['value'], [1, 2])
        self.assertEqual(self.request('GET', '/v1/kv/expired')[0], 404)
        self.assertEqual(self.request('GET', '/v1/kv/reset')[1]['value'], 2)
        self.assertNotIn('expired', json.loads(self.data.read_text())['entries'])
        self.request('PUT', '/v1/kv/short', {'value': 0, 'ttl_seconds': .05})
        time.sleep(.08)
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 1})[0], 201)

    def test_invalid_requests(self):
        for raw in ['{', '[]', 'null', '{}', '{"value":NaN}', '{"value":1e999}', b'\xff']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request('PUT', '/v1/kv/k', raw=raw)[0], 400)
        for ttl in [0, -1, True, None, '1', float('inf'), float('nan')]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request('PUT', '/v1/kv/k', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ['', 'a/b', '%2F', '%FF', '%', '%XY']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('GET', '/missing')[0], 404)
        for method in ['POST', 'PATCH', 'OPTIONS', 'BOGUS']:
            self.assertEqual(self.request(method, '/v1/kv/k')[0], 405)
        self.assertEqual(self.request('PUT', '/health', {'value': 1})[0], 405)
        self.assertEqual(self.request('PUT', '/v1/kv/k', raw='x', headers={'Content-Length': '-1'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/k', raw='x', headers={'Transfer-Encoding': 'chunked'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/k', raw='x', headers={'Content-Length': str(1024 * 1024 + 1)})[0], 413)

    def test_body_limit_boundary(self):
        raw = '{"value":"' + 'x' * (1024 * 1024 - 12) + '"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/large', raw=raw)[0], 201)

    def test_concurrent_writes(self):
        def put(index):
            return self.request('PUT', '/v1/kv/k' + str(index), {'value': index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(put, range(40))), [201] * 40)
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 40)
        self.stop()
        self.start()
        for index in range(40):
            self.assertEqual(self.request('GET', '/v1/kv/k' + str(index))[1]['value'], index)


if __name__ == '__main__':
    unittest.main()
