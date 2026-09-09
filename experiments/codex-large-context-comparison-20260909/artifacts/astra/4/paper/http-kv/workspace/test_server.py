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


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.temp.name) / 'state.json'
        self.start()

    def start(self):
        self.log = open(Path(self.temp.name) / 'stderr.log', 'a')
        self.proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name('server.py')),
                                      '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)],
                                     stdout=subprocess.PIPE, stderr=self.log, text=True)
        line = self.proc.stdout.readline()
        self.assertTrue(line.startswith('LISTENING '), line)
        self.port = int(line.split()[1])

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=15)
        self.assertEqual(self.proc.returncode, 0)
        self.assertEqual(self.proc.stdout.read(), '')
        self.proc.stdout.close()
        self.log.close()

    def tearDown(self):
        if self.proc.poll() is None:
            self.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            conn.request(method, path, body=raw if raw is not None else (json.dumps(body) if body is not None else None), headers=headers or {})
            response = conn.getresponse()
            payload = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(payload) if payload else None
        finally:
            conn.close()

    def test_crud_restart_and_unicode(self):
        key = 'snow 雪 space'
        path = '/v1/kv/' + quote(key, safe='')
        value = {'nested': [None, True, 42, '雪']}
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        self.assertEqual(self.request('PUT', path, {'value': value})[0], 201)
        self.assertEqual(self.request('PUT', path, {'value': value})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request('GET', path), (200, {'key': key, 'value': value}))
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': [key]}))
        self.assertEqual(self.request('DELETE', path), (204, None))
        self.assertEqual(self.request('DELETE', path)[0], 404)
        self.assertEqual(self.request('GET', path)[0], 404)

    def test_expiry_restart_and_replacement(self):
        self.request('PUT', '/v1/kv/short', {'value': 1, 'ttl_seconds': 0.15})
        self.request('PUT', '/v1/kv/keep', {'value': 2, 'ttl_seconds': 0.15})
        self.request('PUT', '/v1/kv/keep', {'value': 3})
        self.stop()
        time.sleep(0.2)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/short')[0], 404)
        self.assertEqual(self.request('GET', '/v1/keys')[1], {'keys': ['keep']})
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 4})[0], 201)
        self.request('PUT', '/v1/kv/live-expiry', {'value': 0, 'ttl_seconds': 0.05})
        time.sleep(0.08)
        self.assertEqual(self.request('DELETE', '/v1/kv/live-expiry')[0], 404)

    def test_invalid_requests(self):
        for raw in ('{', '[]', 'null', '{}', '{"value":NaN}', '{"value":1e999}'):
            self.assertEqual(self.request('PUT', '/v1/kv/a', raw=raw)[0], 400)
        for ttl in (0, -1, True, None, '1', float('inf')):
            self.assertEqual(self.request('PUT', '/v1/kv/a', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ('', '%2F', 'a/b', '%ff', '%zz', '%'):
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('POST', '/v1/kv/a')[0], 405)
        self.assertEqual(self.request('PATCH', '/health')[0], 405)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw='x' * (1024 * 1024 + 1))[0], 413)
        self.assertEqual(self.request('PUT', '/v1/kv/a', raw=b'\xff')[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/a', headers={'Content-Length': '-1'})[0], 400)
        raw = '{"value":"' + 'x' * (1024 * 1024 - 12) + '"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/limit', raw=raw)[0], 201)

    def test_concurrent_persistence(self):
        def put(i):
            return self.request('PUT', f'/v1/kv/k{i:03}', {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(40))), [201] * 40)
        self.stop()
        state = json.loads(self.data.read_text())
        self.assertEqual(len(state), 40)
        self.start()
        self.assertEqual(self.request('GET', '/v1/keys')[1]['keys'], sorted(state))
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            statuses = list(pool.map(lambda _: self.request('PUT', '/v1/kv/shared', {'value': 1})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)


if __name__ == '__main__':
    unittest.main()
