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


ROOT = Path(__file__).parent


class RunningServer:
    def __init__(self, data: Path):
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1",
             "--port", "0", "--data", str(data)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        line = self.process.stdout.readline()
        if not line.startswith("LISTENING "):
            error = self.process.stderr.read()
            raise RuntimeError(f"failed to start: {line!r} {error}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        if body is not None and not isinstance(body, (bytes, str)):
            body = json.dumps(body, allow_nan=True)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, response.getheader("Content-Type"), raw)
        connection.close()
        return result

    def stop(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=4)
        self.process.stdout.close()
        self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "store.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.stop()
        self.temp.cleanup()

    def json_request(self, method, path, body=None):
        status, content_type, raw = self.server.request(method, path, body)
        return status, content_type, json.loads(raw) if raw else None

    def test_crud_keys_and_encoded_key(self):
        path = "/v1/kv/" + quote("hello world")
        status, content_type, body = self.json_request("PUT", path, {"value": {"x": 1}})
        self.assertEqual((status, content_type), (201, "application/json"))
        self.assertEqual(body["value"], {"x": 1})
        self.assertEqual(self.json_request("PUT", path, {"value": None})[0], 200)
        self.assertEqual(self.json_request("GET", path)[2], {"key": "hello world", "value": None})
        self.json_request("PUT", "/v1/kv/a", {"value": 2})
        self.assertEqual(self.json_request("GET", "/v1/keys")[2]["keys"], ["a", "hello world"])
        status, _, raw = self.server.request("DELETE", path)
        self.assertEqual((status, raw), (204, b""))
        self.assertEqual(self.json_request("GET", path)[0], 404)

    def test_ttl_and_restart_persistence(self):
        self.json_request("PUT", "/v1/kv/permanent", {"value": [1, 2]})
        self.json_request("PUT", "/v1/kv/brief", {"value": True, "ttl_seconds": 0.08})
        time.sleep(0.12)
        self.assertEqual(self.json_request("GET", "/v1/kv/brief")[0], 404)
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.json_request("GET", "/v1/kv/permanent")[2]["value"], [1, 2])
        self.assertEqual(self.json_request("GET", "/v1/keys")[2]["keys"], ["permanent"])

    def test_validation_and_routes(self):
        self.assertEqual(self.json_request("GET", "/health")[2], {"status": "ok"})
        for ttl in (0, -1, True, float("inf")):
            self.assertEqual(self.json_request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/x", b"{")[0], 400)
        self.assertEqual(self.json_request("PUT", "/v1/kv/x", [1])[0], 400)
        self.assertEqual(self.json_request("PUT", "/v1/kv/x", {"ttl_seconds": 1})[0], 400)
        self.assertEqual(self.json_request("GET", "/v1/kv/a%2Fb")[0], 400)
        self.assertEqual(self.json_request("GET", "/missing")[0], 404)
        self.assertEqual(self.json_request("POST", "/health", {})[0], 405)

    def test_body_limit(self):
        status, _, _ = self.server.request(
            "PUT", "/v1/kv/x", b"", {"Content-Length": str(1024 * 1024 + 1)})
        self.assertEqual(status, 413)


if __name__ == "__main__":
    unittest.main()
