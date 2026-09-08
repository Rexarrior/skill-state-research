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


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.temp.name) / "state.json"
        self.start()

    def start(self):
        self.process = subprocess.Popen([sys.executable, "server.py", "--port", "0", "--data", str(self.data)], cwd=Path(__file__).parent, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = self.process.stdout.readline()
        self.assertTrue(line.startswith("LISTENING "), line)
        self.port = int(line.split()[1])

    def stop(self):
        self.process.terminate()
        self.assertEqual(self.process.wait(timeout=10), 0)
        self.assertEqual(self.process.stdout.read(), "")
        self.process.stdout.close()

    def tearDown(self):
        if self.process.poll() is None:
            self.stop()
        self.temp.cleanup()

    def request(self, method, path, document=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        body = raw if raw is not None else (json.dumps(document) if document is not None else None)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        status = response.status
        connection.close()
        return status, json.loads(payload) if payload else None

    def test_crud_and_restart(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        key = "hello world ☃"
        path = "/v1/kv/" + quote(key)
        value = {"nested": [None, True, 42, "text"]}
        self.assertEqual(self.request("PUT", path, {"value": value})[0], 201)
        self.assertEqual(self.request("GET", path), (200, {"key": key, "value": value}))
        self.assertEqual(self.request("PUT", path, {"value": False})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path)[1]["value"], False)
        self.assertEqual(self.request("DELETE", path), (204, None))
        self.assertEqual(self.request("DELETE", path)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_ttl(self):
        self.request("PUT", "/v1/kv/expired", {"value": 1, "ttl_seconds": 0.2})
        self.request("PUT", "/v1/kv/kept", {"value": 1, "ttl_seconds": 0.2})
        self.request("PUT", "/v1/kv/kept", {"value": 2})
        self.stop()
        time.sleep(0.3)
        self.start()
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["kept"]}))
        self.assertEqual(self.request("GET", "/v1/kv/expired")[0], 404)
        self.assertEqual(self.request("DELETE", "/v1/kv/expired")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/expired", {"value": 3, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.1)
        self.assertEqual(self.request("PUT", "/v1/kv/expired", {"value": 4})[0], 201)

    def test_invalid_requests(self):
        for raw in ["{", "[]", "null", '{}', '{"value":NaN}', '{"value":1e999}', '{"value":1,"extra":2}']:
            self.assertEqual(self.request("PUT", "/v1/kv/k", raw=raw)[0], 400, raw)
        for ttl in [None, True, False, 0, -1, "1", [], {}, float("inf")]:
            self.assertEqual(self.request("PUT", "/v1/kv/k", {"value": 1, "ttl_seconds": ttl})[0], 400)
        for key in ["", "%FF", "%", "%GG", "a%2Fb", "a/b", "%ED%A0%80"]:
            self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400, key)
        self.assertEqual(self.request("POST", "/health")[0], 405)
        self.assertEqual(self.request("PATCH", "/v1/kv/k")[0], 405)
        self.assertEqual(self.request("PUT", "/health", {"value": 1})[0], 405)
        self.assertEqual(self.request("GET", "/unknown")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/k", raw="x" * (1024 * 1024 + 1))[0], 413)
        self.assertEqual(self.request("PUT", "/v1/kv/k", raw="{}", headers={"Content-Length": "-1"})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/k", raw=b'\xff')[0], 400)

    def test_concurrency_and_durable_writes(self):
        def put(index):
            return self.request("PUT", f"/v1/kv/k{index:03d}", {"value": index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(40))), [201] * 40)
        expected = [f"k{i:03d}" for i in range(40)]
        self.assertEqual(self.request("GET", "/v1/keys")[1]["keys"], expected)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.request("PUT", "/v1/kv/shared", {"value": i})[0], range(20)))
        self.assertEqual(results.count(201), 1)
        self.assertEqual(results.count(200), 19)
        self.process.kill()
        self.process.wait(timeout=10)
        self.process.stdout.close()
        self.start()
        self.assertEqual(self.request("GET", "/v1/keys")[1]["keys"], expected + ["shared"])
        self.assertEqual(len(json.loads(self.data.read_text())["entries"]), 41)


if __name__ == "__main__":
    unittest.main()
