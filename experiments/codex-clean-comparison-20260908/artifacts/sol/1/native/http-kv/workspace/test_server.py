import http.client
import json
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "store.json"
        self.start()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline().strip()
        self.assertTrue(line.startswith("LISTENING "), line)
        self.port = int(line.split()[1])

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        diagnostics = self.process.stderr.read()
        self.process.stdout.close()
        self.process.stderr.close()
        self.assertEqual(self.process.returncode, 0, diagnostics)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, response.getheader("Content-Type"), json.loads(raw) if raw else None)
        connection.close()
        return result

    def test_lifecycle_encoding_and_persistence(self):
        self.assertEqual(self.request("PUT", "/v1/kv/hello%20world", {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/hello%20world", {"value": [2, True]})[0], 200)
        self.assertEqual(self.request("GET", "/v1/kv/hello%20world")[2], {"key": "hello world", "value": [2, True]})
        self.assertEqual(self.request("GET", "/v1/keys")[2], {"keys": ["hello world"]})
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/hello%20world")[0], 200)
        self.assertEqual(self.request("DELETE", "/v1/kv/hello%20world")[0], 204)
        self.assertEqual(self.request("GET", "/v1/kv/hello%20world")[0], 404)

    def test_ttl_and_validation(self):
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.08)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/a")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": 0})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": None})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/a", b"not json", {"Content-Length": "8"})[0], 400)
        self.assertEqual(self.request("POST", "/health")[0], 405)
        self.assertEqual(self.request("GET", "/missing")[0], 404)

    def test_body_limit(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.putrequest("PUT", "/v1/kv/large")
        connection.putheader("Content-Length", str(1024 * 1024 + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        connection.close()

    def test_concurrent_writes_are_all_persisted(self):
        def put(number):
            return self.request("PUT", f"/v1/kv/k{number}", {"value": number})[0]

        with ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(put, range(24)))
        self.assertEqual(statuses, [201] * 24)
        self.assertEqual(self.request("GET", "/v1/keys")[2]["keys"], sorted(f"k{i}" for i in range(24)))
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/keys")[2]["keys"], sorted(f"k{i}" for i in range(24)))


if __name__ == "__main__":
    unittest.main()
