"""Black-box integration tests for server.py."""

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


ROOT = Path(__file__).resolve().parent


class RunningServer:
    def __init__(self, data_path: Path) -> None:
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1",
             "--port", "0", "--data", str(data_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            error = self.process.stderr.read() if self.process.stderr else ""
            self.process.kill()
            raise RuntimeError(f"server failed to start: {line!r} {error}")
        self.port = int(line.split()[1])

    def request(self, method: str, path: str, body=None, headers=None):
        request_headers = dict(headers or {})
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body, allow_nan=False).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        result_headers = {key.lower(): value for key, value in response.getheaders()}
        connection.close()
        return response.status, result_headers, json.loads(raw) if raw else None

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.data_path = Path(self.temporary.name) / "nested" / "store.json"
        self.server = RunningServer(self.data_path)

    def tearDown(self) -> None:
        self.server.stop()
        self.temporary.cleanup()

    def test_crud_keys_and_encoding(self) -> None:
        key = "snow man ☃"
        path = "/v1/kv/" + quote(key, safe="")
        status, headers, payload = self.server.request("PUT", path, {"value": {"n": 1}})
        self.assertEqual(201, status)
        self.assertEqual("application/json", headers["content-type"])
        self.assertEqual({"key": key, "value": {"n": 1}}, payload)
        self.assertEqual(200, self.server.request("PUT", path, {"value": None})[0])
        self.assertEqual({"key": key, "value": None}, self.server.request("GET", path)[2])
        self.server.request("PUT", "/v1/kv/a", {"value": 1})
        self.assertEqual({"keys": ["a", key]}, self.server.request("GET", "/v1/keys")[2])
        self.assertEqual(204, self.server.request("DELETE", path)[0])
        self.assertEqual(404, self.server.request("GET", path)[0])
        self.assertEqual(404, self.server.request("DELETE", path)[0])

    def test_health_errors_and_body_limit(self) -> None:
        self.assertEqual((200, {"status": "ok"}),
                         (self.server.request("GET", "/health")[0],
                          self.server.request("GET", "/health")[2]))
        cases = [
            ("PUT", "/v1/kv/a", b"{", {"Content-Type": "application/json"}),
            ("PUT", "/v1/kv/a", [], None),
            ("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": 0}, None),
            ("PUT", "/v1/kv/a", {"ttl_seconds": 2}, None),
            ("PUT", "/v1/kv/", {"value": 1}, None),
            ("PUT", "/v1/kv/a%2Fb", {"value": 1}, None),
            ("POST", "/health", {}, None),
            ("GET", "/unknown", None, None),
        ]
        for method, path, body, headers in cases:
            with self.subTest(method=method, path=path, body=body):
                status, response_headers, payload = self.server.request(method, path, body, headers)
                self.assertGreaterEqual(status, 400)
                self.assertLess(status, 500)
                self.assertEqual("application/json", response_headers["content-type"])
                self.assertIn("error", payload)
        self.assertEqual(413, self.server.request(
            "PUT", "/v1/kv/a", None,
            {"Content-Type": "application/json", "Content-Length": str(1024 * 1024 + 1)},
        )[0])

    def test_ttl_persistence_and_restart(self) -> None:
        self.assertEqual(201, self.server.request(
            "PUT", "/v1/kv/permanent", {"value": "yes"})[0])
        self.assertEqual(201, self.server.request(
            "PUT", "/v1/kv/short", {"value": "gone", "ttl_seconds": 0.15})[0])
        self.server.stop()
        self.server = RunningServer(self.data_path)
        self.assertEqual("yes", self.server.request("GET", "/v1/kv/permanent")[2]["value"])
        time.sleep(0.2)
        self.assertEqual(404, self.server.request("GET", "/v1/kv/short")[0])
        self.server.stop()
        self.server = RunningServer(self.data_path)
        self.assertEqual({"keys": ["permanent"]}, self.server.request("GET", "/v1/keys")[2])
        persisted = json.loads(self.data_path.read_text(encoding="utf-8"))
        self.assertNotIn("short", persisted["entries"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
