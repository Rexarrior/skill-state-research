from __future__ import annotations

import http.client
import json
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
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline()
        if not line.startswith("LISTENING "):
            stderr = self.process.stderr.read()
            raise RuntimeError(f"server failed to start: {line!r} {stderr}")
        self.port = int(line.split()[1])

    def request(self, method: str, path: str, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = body if isinstance(body, bytes) else None if body is None else json.dumps(body).encode()
        connection.request(method, path, encoded, headers or {})
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, response.getheader("Content-Type"), payload)
        connection.close()
        return result

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data = Path(self.temporary.name) / "nested" / "data.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.stop()
        self.temporary.cleanup()

    def json_request(self, method, path, body=None):
        status, content_type, payload = self.server.request(method, path, body)
        self.assertEqual(content_type, "application/json")
        return status, None if not payload else json.loads(payload)

    def test_crud_keys_and_encoded_key(self):
        key = "snow ☃ key"
        path = "/v1/kv/" + quote(key)
        self.assertEqual(self.json_request("PUT", path, {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.json_request("PUT", path, {"value": [2]})[0], 200)
        self.assertEqual(self.json_request("GET", path), (200, {"key": key, "value": [2]}))
        self.assertEqual(self.json_request("GET", "/v1/keys"), (200, {"keys": [key]}))
        self.assertEqual(self.json_request("DELETE", path), (204, None))
        self.assertEqual(self.json_request("GET", path)[0], 404)

    def test_persistence_across_restart(self):
        self.assertEqual(self.json_request("PUT", "/v1/kv/a", {"value": False})[0], 201)
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.json_request("GET", "/v1/kv/a"), (200, {"key": "a", "value": False}))

    def test_ttl_expires_and_does_not_return(self):
        self.assertEqual(
            self.json_request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.05})[0], 201
        )
        time.sleep(0.08)
        self.assertEqual(self.json_request("GET", "/v1/kv/short")[0], 404)
        self.assertEqual(self.json_request("GET", "/v1/keys"), (200, {"keys": []}))

    def test_validation_and_routes(self):
        for ttl in (0, -1, True, "1"):
            self.assertEqual(self.json_request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.json_request("PUT", "/v1/kv/", {"value": 1})[0], 400)
        self.assertEqual(self.json_request("GET", "/v1/kv/a%2Fb")[0], 400)
        self.assertEqual(self.json_request("POST", "/health", {})[0], 405)
        self.assertEqual(self.json_request("GET", "/missing")[0], 404)
        self.assertEqual(self.json_request("GET", "/health"), (200, {"status": "ok"}))

    def test_malformed_and_oversized_bodies(self):
        status, _, payload = self.server.request(
            "PUT", "/v1/kv/x", b"not json", {"Content-Length": "8"}
        )
        # request() JSON-encodes non-None bodies, so issue the malformed request directly.
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request("PUT", "/v1/kv/x", b"not json")
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        response.read()
        connection.close()
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request("PUT", "/v1/kv/x", body=b"", headers={"Content-Length": str(1024 * 1024 + 1)})
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        connection.close()


if __name__ == "__main__":
    unittest.main()
