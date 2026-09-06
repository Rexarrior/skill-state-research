import http.client
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).parent


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "data.json"
        self.start()

    def tearDown(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)
        self.temp.cleanup()

    def start(self):
        self.proc = subprocess.Popen([sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = self.proc.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING [1-9][0-9]*$")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body).encode()
        conn.request(method, path, body=encoded, headers={} if encoded is None else {"Content-Type": "application/json"})
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        return response.status, json.loads(raw) if raw else None

    def test_crud_unicode_ttl_and_restart(self):
        key = quote("hello world", safe="")
        self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": None})[0], 200)
        self.assertEqual(self.request("GET", "/v1/kv/" + key), (200, {"key": "hello world", "value": None}))
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["hello world"]}))
        self.assertEqual(self.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": .05})[0], 201)
        time.sleep(.08)
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)
        self.proc.terminate(); self.proc.wait(timeout=5)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/" + key)[1]["value"], None)
        self.assertEqual(self.request("DELETE", "/v1/kv/" + key)[0], 204)

    def test_errors(self):
        self.assertEqual(self.request("GET", "/nope")[0], 404)
        self.assertEqual(self.request("POST", "/health")[0], 405)
        self.assertEqual(self.request("PUT", "/v1/kv/x", {"ttl_seconds": 1})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0})[0], 400)


if __name__ == "__main__":
    unittest.main()
