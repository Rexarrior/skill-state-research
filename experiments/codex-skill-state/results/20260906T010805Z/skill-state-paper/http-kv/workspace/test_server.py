import http.client
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).parent


class RunningServer:
    def __init__(self, data: Path):
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1", "--port", "0", "--data", str(data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            raise RuntimeError(f"server failed: {line} {self.process.stderr.read()}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body).encode()
        request_headers = {} if headers is None else dict(headers)
        if encoded is not None:
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, encoded, request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = response.status, response.getheader("Content-Type"), raw
        connection.close()
        return result

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=3)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "data.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.close()
        self.temp.cleanup()

    def test_crud_sorting_encoding_and_restart(self):
        status, content_type, raw = self.server.request("GET", "/health")
        self.assertEqual((status, content_type, json.loads(raw)), (200, "application/json", {"status": "ok"}))
        self.assertEqual(self.server.request("PUT", "/v1/kv/z", {"value": [1, None]})[0], 201)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a%20b", {"value": "first"})[0], 201)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a%20b", {"value": "second"})[0], 200)
        self.assertEqual(json.loads(self.server.request("GET", "/v1/kv/a%20b")[2]), {"key": "a b", "value": "second"})
        self.assertEqual(json.loads(self.server.request("GET", "/v1/keys")[2]), {"keys": ["a b", "z"]})
        self.server.close()
        self.server = RunningServer(self.data)
        self.assertEqual(json.loads(self.server.request("GET", "/v1/kv/z")[2])["value"], [1, None])
        self.assertEqual(self.server.request("DELETE", "/v1/kv/z")[0], 204)
        self.assertEqual(self.server.request("DELETE", "/v1/kv/z")[0], 404)

    def test_ttl_and_validation(self):
        self.assertEqual(self.server.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.08})[0], 201)
        time.sleep(0.12)
        self.assertEqual(self.server.request("GET", "/v1/kv/short")[0], 404)
        for ttl in (0, -1, True, float("inf")):
            self.assertEqual(self.server.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/x", [1])[0], 400)
        self.assertEqual(self.server.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.server.request("GET", "/missing")[0], 404)


if __name__ == "__main__":
    unittest.main()
