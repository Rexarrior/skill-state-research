import concurrent.futures
import http.client
import json
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from server import Store


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.temp.name) / "state.json"
        self.start()

    def start(self):
        self.log = tempfile.TemporaryFile(dir=self.temp.name)
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("server.py")),
             "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE, stderr=self.log, text=True)
        if not select.select([self.process.stdout], [], [], 5)[0]:
            self.process.kill()
            self.process.wait()
            self.fail("Server did not announce its port")
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            self.process.wait(timeout=5)
            self.log.seek(0)
            diagnostic = self.log.read().decode("utf-8", errors="replace")
            self.process.stdout.close()
            self.log.close()
            self.temp.cleanup()
            self.fail(f"Server failed to start: {diagnostic}")
        self.assertRegex(line, r"^LISTENING [0-9]+$")
        self.port = int(line.split()[1])

    def stop(self):
        self.process.terminate()
        try:
            self.assertEqual(self.process.wait(timeout=15), 0)
            self.assertEqual(self.process.stdout.read(), "")
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.process.stdout.close()
            self.log.close()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            payload = raw if raw is not None else (json.dumps(body) if body is not None else None)
            connection.request(method, path, body=payload, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_and_restart(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        value = {"nested": [None, True, 3.25, "雪"]}
        path = "/v1/kv/a%20%E9%9B%AA"
        self.assertEqual(self.request("PUT", path, {"value": value})[0], 201)
        self.assertEqual(self.request("GET", path), (200, {"key": "a 雪", "value": value}))
        self.assertEqual(self.request("PUT", path, {"value": False})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path)[1]["value"], False)
        self.assertEqual(self.request("DELETE", path), (204, None))
        self.assertEqual(self.request("DELETE", path)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_expiry(self):
        self.request("PUT", "/v1/kv/expired", {"value": 1, "ttl_seconds": 0.15})
        self.request("PUT", "/v1/kv/removed-ttl", {"value": 1, "ttl_seconds": 0.15})
        self.request("PUT", "/v1/kv/removed-ttl", {"value": 2})
        self.stop()
        time.sleep(0.2)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/expired")[0], 404)
        self.assertEqual(self.request("DELETE", "/v1/kv/expired")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["removed-ttl"]})
        self.assertEqual(self.request("PUT", "/v1/kv/expired", {"value": 3})[0], 201)
        self.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.02})
        time.sleep(0.04)
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)

    def test_validation(self):
        for raw in ('{', '[]', '{}', 'null', '{"value": NaN}', '{"value": 1e999}',
                    '{"value": 1, "ttl_seconds": null}', '{"value": 1, "ttl_seconds": true}',
                    '{"value": 1, "ttl_seconds": 0}', '{"value": 1, "ttl_seconds": -1}',
                    '{"value": 1, "ttl_seconds": "2"}'):
            with self.subTest(raw=raw):
                self.assertEqual(self.request("PUT", "/v1/kv/test", raw=raw)[0], 400)
        for key in ('', '%FF', 'a%2Fb', 'a/b', '%', '%GG'):
            with self.subTest(key=key):
                self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)
        self.assertEqual(self.request("POST", "/v1/kv/test", {})[0], 405)
        self.assertEqual(self.request("WAT", "/health")[0], 405)
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/test", raw=b'\xff')[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/test", raw=b'', headers={"Content-Length": "1048577"})[0], 413)
        self.assertEqual(self.request("PUT", "/v1/kv/test", raw=b'', headers={"Content-Length": "-1"})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/test", raw=b'', headers={"Transfer-Encoding": "chunked"})[0], 400)
        raw = '{"value":"' + 'x' * (1024 * 1024 - 12) + '"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request("PUT", "/v1/kv/limit", raw=raw)[0], 201)

    def test_concurrency(self):
        def put(i):
            return self.request("PUT", f"/v1/kv/key{i:03}", {"value": i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(40))), [201] * 40)
            statuses = list(pool.map(lambda i: self.request("PUT", "/v1/kv/shared", {"value": i})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)
        expected = [f"key{i:03}" for i in range(40)] + ["shared"]
        self.assertEqual(self.request("GET", "/v1/keys")[1]["keys"], expected)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/keys")[1]["keys"], expected)


class PersistenceTests(unittest.TestCase):
    def test_failed_replace_preserves_committed_state(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "data.json"
            store = Store(path)
            store.execute("PUT", "key", "original")
            before = path.read_bytes()
            with patch("server.os.replace", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    store.execute("PUT", "key", "replacement")
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(store.execute("GET", "key")[1]["value"], "original")
            self.assertEqual(list(Path(directory).iterdir()), [path])


if __name__ == "__main__":
    unittest.main()
