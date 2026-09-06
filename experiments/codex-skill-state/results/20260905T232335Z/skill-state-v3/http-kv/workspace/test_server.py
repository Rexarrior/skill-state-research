import http.client
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent


class RunningServer:
    def __init__(self, data: Path):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline()
        if not line.startswith("LISTENING "):
            raise RuntimeError(f"server failed to start: {line!r} {self.process.stderr.read()}")
        self.port = int(line.split()[1])

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "data.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        encoded = None if body is None else json.dumps(body).encode()
        connection.request(method, path, encoded, headers or {})
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, response.getheader("Content-Type"), raw)
        connection.close()
        return result

    def test_crud_keys_and_restart(self):
        key = "space + unicode-ключ"
        path = "/v1/kv/" + quote(key, safe="")
        self.assertEqual(self.request("PUT", path, {"value": {"x": [1, None]}})[0], 201)
        self.assertEqual(self.request("PUT", path, {"value": "new"})[0], 200)
        status, content_type, raw = self.request("GET", path)
        self.assertEqual((status, content_type), (200, "application/json"))
        self.assertEqual(json.loads(raw), {"key": key, "value": "new"})
        self.assertEqual(json.loads(self.request("GET", "/v1/keys")[2]), {"keys": [key]})
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(json.loads(self.request("GET", path)[2])["value"], "new")
        self.assertEqual(self.request("DELETE", path)[0], 204)
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_ttl_validation_and_expiration(self):
        for ttl in (0, -1, True, "2"):
            self.assertEqual(self.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0.08})[0], 201)
        time.sleep(0.12)
        self.assertEqual(self.request("GET", "/v1/kv/x")[0], 404)
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(json.loads(self.request("GET", "/v1/keys")[2]), {"keys": []})

    def test_errors_and_limit(self):
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("POST", "/health")[0], 405)
        self.assertEqual(self.request("GET", "/v1/kv/")[0], 400)
        self.assertEqual(self.request("GET", "/v1/kv/a%2Fb")[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/x", [1])[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/x", {"other": 1})[0], 400)
        huge = b" " * (1024 * 1024 + 1)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request("PUT", "/v1/kv/x", huge)
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        connection.close()


if __name__ == "__main__":
    unittest.main()
