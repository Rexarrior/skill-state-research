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


class RunningServer:
    def __init__(self, data):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            raise RuntimeError(f"server did not start: {line} {self.process.stderr.read()}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body, allow_nan=False).encode()
        conn.request(method, path, encoded, headers or ({"Content-Type": "application/json"} if body is not None else {}))
        response = conn.getresponse()
        payload = response.read()
        result = (response.status, response.getheader("Content-Type"), json.loads(payload) if payload else None)
        conn.close()
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "data.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.close()
        self.temp.cleanup()

    def test_crud_sorting_encoding_and_restart(self):
        key = "hello world"
        self.assertEqual(self.server.request("PUT", "/v1/kv/" + quote(key), {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.server.request("PUT", "/v1/kv/z", {"value": None})[0], 201)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a", {"value": True})[0], 201)
        self.assertEqual(self.server.request("GET", "/v1/keys")[2], {"keys": ["a", key, "z"]})
        self.assertEqual(self.server.request("PUT", "/v1/kv/" + quote(key), {"value": 2})[0], 200)
        self.server.close()
        self.server = RunningServer(self.data)
        self.assertEqual(self.server.request("GET", "/v1/kv/" + quote(key))[2], {"key": key, "value": 2})
        self.assertEqual(self.server.request("DELETE", "/v1/kv/" + quote(key))[0], 204)
        self.assertEqual(self.server.request("GET", "/v1/kv/" + quote(key))[0], 404)

    def test_ttl_validation_errors_and_limits(self):
        self.assertEqual(self.server.request("GET", "/health"), (200, "application/json", {"status": "ok"}))
        self.assertEqual(self.server.request("PUT", "/v1/kv/temp", {"value": 1, "ttl_seconds": 0.08})[0], 201)
        time.sleep(0.12)
        self.assertEqual(self.server.request("GET", "/v1/kv/temp")[0], 404)
        for ttl in (0, -1, True):
            self.assertEqual(self.server.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/", {"value": 1})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        self.assertEqual(self.server.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.server.request("GET", "/unknown")[0], 404)

        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        conn.request("PUT", "/v1/kv/x", b"{", {"Content-Type": "application/json"})
        self.assertEqual(conn.getresponse().status, 400)
        conn.close()
        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        conn.request("PUT", "/v1/kv/x", b"x" * (1024 * 1024 + 1))
        self.assertEqual(conn.getresponse().status, 413)
        conn.close()


if __name__ == "__main__":
    unittest.main()
