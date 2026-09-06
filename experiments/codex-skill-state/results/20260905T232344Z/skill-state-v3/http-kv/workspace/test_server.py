from __future__ import annotations

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


ROOT = Path(__file__).resolve().parent


class RunningServer:
    def __init__(self, data: Path):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data)],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        line = self.process.stdout.readline() if self.process.stdout else ""
        if not line.startswith("LISTENING "):
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise RuntimeError(f"server did not start: {line!r} {stderr}")
        self.port = int(line.split()[1])

    def request(self, method: str, path: str, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body, separators=(",", ":"), allow_nan=True)
        request_headers = {} if headers is None else dict(headers)
        if encoded is not None:
            request_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, response.getheader("Content-Type"), json.loads(raw) if raw else None)
        connection.close()
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "store.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.close()
        self.temp.cleanup()

    def test_crud_encoded_keys_and_sorting(self):
        key = "snow ☃ space"
        path = "/v1/kv/" + quote(key, safe="")
        self.assertEqual(self.server.request("PUT", path, {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.server.request("PUT", path, {"value": [2]})[0], 200)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a", {"value": None})[0], 201)
        status, content_type, body = self.server.request("GET", path)
        self.assertEqual((status, content_type, body), (200, "application/json", {"key": key, "value": [2]}))
        self.assertEqual(self.server.request("GET", "/v1/keys")[2], {"keys": ["a", key]})
        self.assertEqual(self.server.request("DELETE", path)[:2], (204, "application/json"))
        self.assertEqual(self.server.request("DELETE", path)[0], 404)

    def test_persistence_restart_and_ttl(self):
        self.assertEqual(self.server.request("PUT", "/v1/kv/stable", {"value": False})[0], 201)
        self.assertEqual(self.server.request("PUT", "/v1/kv/brief", {"value": 3, "ttl_seconds": 0.15})[0], 201)
        self.server.close()
        time.sleep(0.2)
        self.server = RunningServer(self.data)
        self.assertEqual(self.server.request("GET", "/v1/kv/stable")[2]["value"], False)
        self.assertEqual(self.server.request("GET", "/v1/kv/brief")[0], 404)
        on_disk = json.loads(self.data.read_text(encoding="utf-8"))
        self.assertNotIn("brief", on_disk["entries"])

    def test_validation_routes_and_health(self):
        self.assertEqual(self.server.request("GET", "/health"), (200, "application/json", {"status": "ok"}))
        cases = [
            ("PUT", "/v1/kv/x", [], 400),
            ("PUT", "/v1/kv/x", {}, 400),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0}, 400),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": float("nan")}, 400),
            ("GET", "/v1/kv/", None, 400),
            ("GET", "/v1/kv/a%2Fb", None, 400),
            ("GET", "/missing", None, 404),
            ("POST", "/health", {}, 405),
        ]
        for method, path, body, expected in cases:
            with self.subTest(method=method, path=path, body=body):
                self.assertEqual(self.server.request(method, path, body)[0], expected)

    def test_malformed_json_and_body_limit(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request("PUT", "/v1/kv/x", body="{", headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        response.read()
        connection.close()

        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request(
            "PUT", "/v1/kv/x", body=b"", headers={"Content-Length": str(1024 * 1024 + 1)}
        )
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        response.read()
        connection.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
