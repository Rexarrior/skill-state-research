"""Black-box integration tests for server.py."""

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


ROOT = Path(__file__).resolve().parent


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data = Path(self.temporary.name) / "nested" / "store.json"
        self.start()

    def tearDown(self):
        self.stop()
        self.temporary.cleanup()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline()
        self.assertTrue(line.startswith("LISTENING "), line)
        self.port = int(line.split()[1])

    def stop(self):
        if getattr(self, "process", None) and self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        if getattr(self, "process", None):
            self.process.stdout.close()
            self.process.stderr.close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        content_type = response.getheader("Content-Type")
        connection.close()
        return response.status, content_type, json.loads(raw) if raw else None

    def test_crud_sorting_encoding_and_restart(self):
        status, content_type, payload = self.request("GET", "/health")
        self.assertEqual((status, content_type, payload), (200, "application/json", {"status": "ok"}))
        self.assertEqual(self.request("PUT", "/v1/kv/z", {"value": [1, None]})[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/a%20b", {"value": "first"})[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/a%20b", {"value": "second"})[0], 200)
        self.assertEqual(self.request("GET", "/v1/kv/a%20b")[2], {"key": "a b", "value": "second"})
        self.assertEqual(self.request("GET", "/v1/keys")[2], {"keys": ["a b", "z"]})

        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/z")[2], {"key": "z", "value": [1, None]})
        self.assertEqual(self.request("DELETE", "/v1/kv/z"), (204, None, None))
        self.assertEqual(self.request("GET", "/v1/kv/z")[0], 404)

    def test_ttl_and_validation(self):
        self.assertEqual(self.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.08})[0], 201)
        time.sleep(0.12)
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)
        self.stop()
        self.start()
        self.assertNotIn("short", self.request("GET", "/v1/keys")[2]["keys"])

        invalid = [
            ("PUT", "/v1/kv/x", "{", {}),
            ("PUT", "/v1/kv/x", [], {}),
            ("PUT", "/v1/kv/x", {"ttl_seconds": 1}, {}),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0}, {}),
            ("PUT", "/v1/kv/x", '{"value":1,"ttl_seconds":NaN}', {}),
            ("PUT", "/v1/kv/a%2Fb", {"value": 1}, {}),
        ]
        for method, path, body, headers in invalid:
            with self.subTest(path=path, body=body):
                self.assertGreaterEqual(self.request(method, path, body, headers)[0], 400)
        self.assertEqual(self.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.request("GET", "/unknown")[0], 404)
        oversized = b" " * (1024 * 1024 + 1)
        self.assertEqual(self.request("PUT", "/v1/kv/x", oversized)[0], 413)


if __name__ == "__main__":
    unittest.main()
