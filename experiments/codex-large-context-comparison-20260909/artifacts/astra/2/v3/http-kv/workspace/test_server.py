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
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.path = Path(self.tmp.name) / "data.json"
        self.log = open(Path(self.tmp.name) / "stderr.log", "w+")
        self.process = None
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(self.path)],
            stdout=subprocess.PIPE, stderr=self.log, text=True)
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING \d+$")
        self.port = int(line.split()[1])

    def stop(self):
        if self.process is not None:
            self.process.terminate()
            self.process.wait(timeout=10)
            self.assertEqual(self.process.returncode, 0)
            self.assertEqual(self.process.stdout.read(), "")
            self.process.stdout.close()
            self.process = None

    def tearDown(self):
        try:
            self.stop()
        finally:
            self.log.close()
            self.tmp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        connection.request(method, path, payload, headers or {})
        response = connection.getresponse()
        data = response.read()
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        status = response.status
        connection.close()
        return status, json.loads(data) if data else None

    def put(self, key, value, **kwargs):
        return self.request("PUT", "/v1/kv/" + quote(key, safe=""), {"value": value, **kwargs})

    def test_crud_and_restart(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        for key, value in [("z", None), ("a b", [1, True, {"x": "☃"}]), ("☃", "snow")]:
            self.assertEqual(self.put(key, value), (201, {"key": key, "value": value}))
        self.assertEqual(self.put("z", 5)[0], 200)
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["a b", "z", "☃"]}))
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/z"), (200, {"key": "z", "value": 5}))
        self.assertEqual(self.request("DELETE", "/v1/kv/z"), (204, None))
        self.assertEqual(self.request("DELETE", "/v1/kv/z")[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/z")[0], 404)

    def test_expiration(self):
        self.put("expires", "old", ttl_seconds=0.15)
        self.put("replace", 1, ttl_seconds=0.15)
        self.put("permanent", 1, ttl_seconds=0.15)
        self.put("permanent", 2)
        time.sleep(0.2)
        self.assertEqual(self.request("GET", "/v1/kv/expires")[0], 404)
        self.assertEqual(self.put("replace", 2)[0], 201)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["permanent", "replace"]})
        self.put("offline", 1, ttl_seconds=0.3)
        self.stop()
        time.sleep(0.35)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/offline")[0], 404)
        self.assertNotIn("offline", json.loads(self.path.read_text())["entries"])

    def test_validation(self):
        for raw in [b"{", b"[]", b"null", b"{}", b'{"value":NaN}', b'{"value":1e999}', b'\xff', b'{"value":0,"extra":1}']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request("PUT", "/v1/kv/key", raw=raw)[0], 400)
        for ttl in [0, -1, True, None, "2", [], float("inf"), float("nan"), 10 ** 400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.put("key", 1, ttl_seconds=ttl)[0], 400)
        for key in ["", "a/b", "%2F", "%ff", "%", "%GG", "%ED%A0%80"]:
            self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)
        for method in ["POST", "PATCH", "OPTIONS", "WHATEVER"]:
            self.assertEqual(self.request(method, "/health")[0], 405)
        self.assertEqual(self.request("PUT", "/health", {"value": 1})[0], 405)
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/key", raw=b"x", headers={"Content-Length": "1048577"})[0], 413)
        self.assertEqual(self.request("PUT", "/v1/kv/key", raw=b"", headers={"Content-Length": "-1"})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/key", raw=b"", headers={"Transfer-Encoding": "chunked"})[0], 400)
        exact = b'{"value":"' + b"x" * (1048576 - 12) + b'"}'
        self.assertEqual(len(exact), 1048576)
        self.assertEqual(self.request("PUT", "/v1/kv/large", raw=exact)[0], 201)

    def test_concurrency_and_atomic_file(self):
        def write(i):
            return self.put(f"key-{i:03}", {"number": i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            statuses = list(pool.map(write, range(60)))
        self.assertEqual(statuses, [201] * 60)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            statuses = list(pool.map(lambda i: self.put("shared", i)[0], range(30)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 29)
        self.assertEqual(len(json.loads(self.path.read_text())["entries"]), 61)
        self.stop()
        self.start()
        self.assertEqual(len(self.request("GET", "/v1/keys")[1]["keys"]), 61)


if __name__ == "__main__":
    unittest.main()
