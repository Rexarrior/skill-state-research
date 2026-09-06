import http.client
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import quote


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data = Path(self.temporary.name) / "store.json"
        self.start()

    def tearDown(self):
        self.stop()
        self.temporary.cleanup()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline()
        self.assertRegex(line, r"^LISTENING \d+\n$")
        self.port = int(line.split()[1])

    def stop(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        if self.process.returncode != 0:
            self.fail(self.process.stderr.read())
        self.process.stdout.close()
        self.process.stderr.close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body).encode()
        connection.request(method, path, encoded, headers or {})
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, response.getheader("Content-Type"), json.loads(raw) if raw else None)
        connection.close()
        return result

    def test_crud_sorting_and_encoded_key(self):
        key = "hello world"
        path = "/v1/kv/" + quote(key)
        self.assertEqual(self.request("PUT", path, {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/z", {"value": None})[0], 201)
        self.assertEqual(self.request("PUT", path, {"value": [1, 2]})[0], 200)
        self.assertEqual(self.request("GET", path)[2], {"key": key, "value": [1, 2]})
        self.assertEqual(self.request("GET", "/v1/keys")[2], {"keys": [key, "z"]})
        self.assertEqual(self.request("DELETE", path)[0], 204)
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_ttl_validation_limits_and_routes(self):
        for ttl in (0, -1, True, float("inf")):
            self.assertEqual(self.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0.08})[0], 201)
        time.sleep(0.12)
        self.assertEqual(self.request("GET", "/v1/kv/x")[0], 404)
        self.assertEqual(self.request("GET", "/health")[2], {"status": "ok"})
        self.assertEqual(self.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        huge = b"x" * (1024 * 1024 + 1)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("PUT", "/v1/kv/x", huge)
        self.assertEqual(connection.getresponse().status, 413)
        connection.close()

    def test_restart_persistence_and_expiry(self):
        self.assertEqual(self.request("PUT", "/v1/kv/keep", {"value": "yes"})[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/drop", {"value": "no", "ttl_seconds": 0.08})[0], 201)
        self.stop()
        time.sleep(0.12)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/keep")[2]["value"], "yes")
        self.assertEqual(self.request("GET", "/v1/kv/drop")[0], 404)
        persisted = json.loads(self.data.read_text())
        self.assertNotIn("drop", persisted["entries"])


if __name__ == "__main__":
    unittest.main()
