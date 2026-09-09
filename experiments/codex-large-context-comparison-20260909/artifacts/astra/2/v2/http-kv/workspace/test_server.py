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
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.tmp.name) / 'data.json'
        self.start()

    def start(self):
        self.log = open(Path(self.tmp.name) / 'stderr.log', 'ab')
        self.proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('server.py')),
             '--host', '127.0.0.1', '--port', '0', '--data', str(self.data)],
            stdout=subprocess.PIPE, stderr=self.log, text=True)
        line = self.proc.stdout.readline().strip()
        self.assertRegex(line, r'^LISTENING [0-9]+$')
        self.port = int(line.split()[1])

    def stop(self):
        self.proc.terminate()
        self.assertEqual(self.proc.wait(timeout=15), 0)
        self.assertEqual(self.proc.stdout.read(), '')
        self.proc.stdout.close()
        self.log.close()

    def tearDown(self):
        if self.proc.poll() is None:
            self.stop()
        self.tmp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            payload = raw if raw is not None else (json.dumps(body) if body is not None else None)
            conn.request(method, path, payload, headers or {})
            response = conn.getresponse()
            data = response.read()
            self.assertEqual(response.getheader('Content-Type'), 'application/json')
            return response.status, json.loads(data) if data else None
        finally:
            conn.close()

    def test_crud_and_values(self):
        self.assertEqual(self.request('GET', '/health'), (200, {'status': 'ok'}))
        for value in [None, False, 12, 2.5, 'hello', [1, 'x'], {'nested': [True]}]:
            status, _ = self.request('PUT', '/v1/kv/item', {'value': value})
            self.assertIn(status, (200, 201))
            self.assertEqual(self.request('GET', '/v1/kv/item'), (200, {'key': 'item', 'value': value}))
        self.assertEqual(self.request('DELETE', '/v1/kv/item'), (204, None))
        self.assertEqual(self.request('DELETE', '/v1/kv/item')[0], 404)
        self.assertEqual(self.request('GET', '/v1/kv/item')[0], 404)
        keys = ['z', 'a b', 'é', 'a+b', '%2F', '?x']
        for key in keys:
            self.assertEqual(self.request('PUT', '/v1/kv/' + quote(key, safe=''), {'value': key})[0], 201)
        self.assertEqual(self.request('GET', '/v1/keys'), (200, {'keys': sorted(keys)}))

    def test_restart_and_expiry(self):
        self.request('PUT', '/v1/kv/live', {'value': {'saved': True}})
        self.request('PUT', '/v1/kv/expired', {'value': 1, 'ttl_seconds': .15})
        self.request('PUT', '/v1/kv/reset', {'value': 1, 'ttl_seconds': .15})
        self.assertEqual(self.request('PUT', '/v1/kv/reset', {'value': 2})[0], 200)
        self.stop()
        time.sleep(.2)
        self.start()
        self.assertEqual(self.request('GET', '/v1/kv/expired')[0], 404)
        self.assertEqual(self.request('GET', '/v1/kv/live')[1]['value'], {'saved': True})
        self.assertEqual(self.request('GET', '/v1/kv/reset')[1]['value'], 2)
        self.assertNotIn('expired', json.loads(self.data.read_text())['entries'])
        self.request('PUT', '/v1/kv/short', {'value': 0, 'ttl_seconds': .05})
        time.sleep(.1)
        self.assertEqual(self.request('PUT', '/v1/kv/short', {'value': 1})[0], 201)

    def test_invalid_requests(self):
        for raw in ['{', '[]', 'null', '{}', '{"value":NaN}', '{"value":1e999}', '{"value":1,"extra":2}', b'\xff']:
            self.assertEqual(self.request('PUT', '/v1/kv/x', raw=raw)[0], 400)
        for ttl in [0, -1, True, None, '1', [], {}, float('inf')]:
            self.assertEqual(self.request('PUT', '/v1/kv/x', {'value': 1, 'ttl_seconds': ttl})[0], 400)
        for key in ['', '%FF', '%', '%GG', 'a/b', 'a%2fb', '%ED%A0%80']:
            self.assertEqual(self.request('PUT', '/v1/kv/' + key, {'value': 1})[0], 400)
        self.assertEqual(self.request('POST', '/health')[0], 405)
        self.assertEqual(self.request('PATCH', '/v1/kv/x')[0], 405)
        self.assertEqual(self.request('PUT', '/health', {'value': 1})[0], 405)
        self.assertEqual(self.request('GET', '/unknown')[0], 404)
        self.assertEqual(self.request('PUT', '/v1/kv/x', raw='{}', headers={'Content-Length': '-1'})[0], 400)
        self.assertEqual(self.request('PUT', '/v1/kv/x', headers={'Content-Length': str(1024 * 1024 + 1)})[0], 413)
        self.assertEqual(self.request('PUT', '/v1/kv/x', headers={'Transfer-Encoding': 'chunked'})[0], 400)
        raw = '{"value":"' + 'x' * (1024 * 1024 - 12) + '"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request('PUT', '/v1/kv/big', raw=raw)[0], 201)

    def test_concurrent_persistence(self):
        def write(i):
            return self.request('PUT', f'/v1/kv/k{i:03}', {'value': i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(write, range(48))), [201] * 48)
        self.stop()
        self.start()
        self.assertEqual(len(self.request('GET', '/v1/keys')[1]['keys']), 48)
        for i in range(48):
            self.assertEqual(self.request('GET', f'/v1/kv/k{i:03}')[1]['value'], i)


if __name__ == '__main__':
    unittest.main()
