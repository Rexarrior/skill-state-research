"""Black-box self-tests for server.py."""

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


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "data.json"
        self.process = None
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
        line = self.process.stdout.readline()
        self.assertRegex(line, r"^LISTENING \d+\n$")
        self.port = int(line.split()[1])

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        if self.process is not None:
            self.process.stdout.close()
            self.process.stderr.close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        if body is not None and not isinstance(body, (bytes, str)):
            body = json.dumps(body, separators=(",", ":"))
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        content_type = response.getheader("Content-Type")
        connection.close()
        return response.status, content_type, json.loads(payload) if payload else None

    def test_crud_sorting_encoded_key_and_persistence(self):
        key = "space ü"
        path = "/v1/kv/" + quote(key)
        self.assertEqual(self.request("PUT", path, {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/z", {"value": False})[0], 201)
        self.assertEqual(self.request("PUT", path, {"value": [1, None]})[0], 200)
        status, content_type, result = self.request("GET", path)
        self.assertEqual((status, content_type), (200, "application/json"))
        self.assertEqual(result, {"key": key, "value": [1, None]})
        self.assertEqual(self.request("GET", "/v1/keys")[2], {"keys": [key, "z"]})

        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path)[2]["value"], [1, None])
        self.assertEqual(self.request("DELETE", path)[:2], (204, None))
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_ttl_validation_and_expiration(self):
        for ttl in (0, -1, True, "1"):
            self.assertEqual(self.request("PUT", "/v1/kv/bad", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/short", {"value": "x", "ttl_seconds": 0.08})[0], 201)
        time.sleep(0.12)
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)
        self.assertNotIn("short", self.request("GET", "/v1/keys")[2]["keys"])

    def test_errors_health_and_body_limit(self):
        self.assertEqual(self.request("GET", "/health")[2], {"status": "ok"})
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("POST", "/health", b"")[0], 405)
        self.assertEqual(self.request("PUT", "/v1/kv/x", "not-json")[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/x", [1, 2])[0], 400)
        self.assertEqual(self.request("GET", "/v1/kv/%2F")[0], 400)
        oversized = b" " * (1024 * 1024 + 1)
        self.assertEqual(self.request("PUT", "/v1/kv/x", oversized)[0], 413)


if __name__ == "__main__":
    unittest.main()
