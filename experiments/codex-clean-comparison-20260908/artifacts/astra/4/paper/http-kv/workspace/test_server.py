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
        self.data = str(Path(self.temp.name) / "state.json")
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("server.py")),
             "--host", "127.0.0.1", "--port", "0", "--data", self.data],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING \d+$")
        self.port = int(line.split()[1])

    def stop(self):
        self.process.terminate()
        self.assertEqual(self.process.wait(timeout=8), 0)
        self.assertEqual(self.process.stdout.read(), "")
        self.process.stdout.close()

    def tearDown(self):
        if self.process.poll() is None:
            self.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=8)
        try:
            payload = raw if raw is not None else (json.dumps(body) if body is not None else None)
            connection.request(method, path, payload)
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_restart_and_expiry(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        key = "snow ☃ space"
        path = "/v1/kv/" + quote(key, safe="")
        value = {"nested": [None, True, 12, "text"]}
        self.assertEqual(self.request("PUT", path, {"value": value})[0], 201)
        self.assertEqual(self.request("GET", path), (200, {"key": key, "value": value}))
        self.assertEqual(self.request("PUT", path, {"value": False})[0], 200)
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1})[0], 201)
        self.request("PUT", "/v1/kv/expired", {"value": 2, "ttl_seconds": 0.15})
        self.stop()
        time.sleep(0.2)
        self.start()
        self.assertEqual(self.request("GET", path)[1]["value"], False)
        self.assertEqual(self.request("GET", "/v1/kv/expired")[0], 404)
        self.assertEqual(self.request("DELETE", "/v1/kv/expired")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["a", key]}))
        self.assertEqual(self.request("DELETE", path), (204, None))
        self.assertEqual(self.request("DELETE", path)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_validation(self):
        for raw in ('{', '[]', '{}', '{"value":NaN}', '{"value":1e999}', '{"value":1,"extra":2}'):
            self.assertEqual(self.request("PUT", "/v1/kv/x", raw=raw)[0], 400, raw)
        for ttl in (0, -1, True, None, "1", [], 1e308):
            if ttl == 1e308:
                continue  # Finite large TTLs are valid.
            self.assertEqual(self.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl})[0], 400)
        for key in ("", "%FF", "%", "a%2Fb", "a/b"):
            self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)
        self.assertEqual(self.request("PATCH", "/v1/kv/x")[0], 405)
        self.assertEqual(self.request("POST", "/health")[0], 405)
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/x", raw="x" * (1024 * 1024 + 1))[0], 413)

    def test_concurrent_mutations(self):
        def put(index):
            return self.request("PUT", f"/v1/kv/k{index:03}", {"value": index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(60))), [201] * 60)
        self.stop()
        self.start()
        self.assertEqual(len(self.request("GET", "/v1/keys")[1]["keys"]), 60)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(lambda i: self.request("PUT", "/v1/kv/shared", {"value": i})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)


if __name__ == "__main__":
    unittest.main()
