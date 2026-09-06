from __future__ import annotations

import http.client
import json
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
    def __init__(self, data: Path) -> None:
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline()
        if not line.startswith("LISTENING "):
            error = self.process.stderr.read()
            raise RuntimeError(f"server failed: {line!r} {error}")
        self.port = int(line.split()[1])

    def request(self, method: str, path: str, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body).encode()
        actual_headers = dict(headers or {})
        if body is not None:
            actual_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=encoded, headers=actual_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, response.getheader("Content-Type"), raw)
        connection.close()
        return result

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)


class ServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "data.json"
        self.server = RunningServer(self.data)

    def tearDown(self) -> None:
        self.server.stop()
        self.temp.cleanup()

    def decoded(self, result):
        status, content_type, raw = result
        self.assertEqual(content_type, "application/json")
        return status, None if not raw else json.loads(raw)

    def test_crud_sorted_keys_and_persistence(self):
        key = "hello world"
        self.assertEqual(self.decoded(self.server.request("PUT", "/v1/kv/" + quote(key), {"value": {"x": 1}}))[0], 201)
        self.assertEqual(self.decoded(self.server.request("PUT", "/v1/kv/z", {"value": False}))[0], 201)
        self.assertEqual(self.decoded(self.server.request("PUT", "/v1/kv/" + quote(key), {"value": [2]}))[0], 200)
        self.assertEqual(self.decoded(self.server.request("GET", "/v1/kv/" + quote(key))), (200, {"key": key, "value": [2]}))
        self.assertEqual(self.decoded(self.server.request("GET", "/v1/keys")), (200, {"keys": [key, "z"]}))
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.decoded(self.server.request("GET", "/v1/kv/" + quote(key)))[0], 200)
        self.assertEqual(self.decoded(self.server.request("DELETE", "/v1/kv/" + quote(key))), (204, None))
        self.assertEqual(self.decoded(self.server.request("GET", "/v1/kv/" + quote(key)))[0], 404)

    def test_ttl_and_validation(self):
        self.assertEqual(self.decoded(self.server.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.08}))[0], 201)
        time.sleep(0.12)
        self.assertEqual(self.decoded(self.server.request("GET", "/v1/kv/short"))[0], 404)
        for ttl in (0, -1, True, float("inf")):
            self.assertEqual(self.decoded(self.server.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl}))[0], 400)
        self.assertEqual(self.decoded(self.server.request("PUT", "/v1/kv/", {"value": 1}))[0], 400)
        self.assertEqual(self.decoded(self.server.request("PUT", "/v1/kv/a%2Fb", {"value": 1}))[0], 400)
        self.assertEqual(self.decoded(self.server.request("POST", "/health", {}))[0], 405)
        self.assertEqual(self.decoded(self.server.request("GET", "/missing"))[0], 404)
        self.assertEqual(self.decoded(self.server.request("GET", "/health")), (200, {"status": "ok"}))

    def test_malformed_and_body_limit(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request("PUT", "/v1/kv/x", body=b"{", headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        response.read()
        connection.close()
        oversized = b'"' + b"x" * (1024 * 1024) + b'"'
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request("PUT", "/v1/kv/x", body=oversized, headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        connection.close()


if __name__ == "__main__":
    unittest.main()
