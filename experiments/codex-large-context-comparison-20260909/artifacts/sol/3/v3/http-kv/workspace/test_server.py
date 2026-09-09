"""Integration tests for the persistent key-value service."""

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
from typing import Any


ROOT = Path(__file__).resolve().parent


class RunningServer:
    def __init__(self, data: Path) -> None:
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            raise RuntimeError(f"server failed to start: {line!r}")
        self.port = int(line.split()[1])

    def request(
        self, method: str, path: str, body: bytes | None = None, headers: dict[str, str] | None = None
    ) -> tuple[int, dict[str, Any] | None, dict[str, str]]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        connection.close()
        return response.status, json.loads(raw) if raw else None, response_headers

    def close(self) -> None:
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
        self.data = Path(self.temporary.name) / "nested" / "store.json"
        self.server = RunningServer(self.data)

    def tearDown(self) -> None:
        self.server.close()
        self.temporary.cleanup()

    @staticmethod
    def body(document: Any) -> bytes:
        return json.dumps(document, separators=(",", ":")).encode()

    def put(self, path: str, document: Any) -> tuple[int, dict[str, Any] | None, dict[str, str]]:
        return self.server.request(
            "PUT", path, self.body(document), {"Content-Type": "application/json"}
        )

    def test_crud_keys_and_encoded_key(self) -> None:
        status, payload, headers = self.put("/v1/kv/a%20key", {"value": {"x": [1, True, None]}})
        self.assertEqual(201, status)
        self.assertEqual("application/json", headers["content-type"])
        self.assertEqual({"key": "a key", "value": {"x": [1, True, None]}}, payload)
        self.assertEqual(200, self.put("/v1/kv/a%20key", {"value": "new"})[0])
        self.assertEqual(201, self.put("/v1/kv/Z", {"value": 1})[0])
        self.assertEqual({"keys": ["Z", "a key"]}, self.server.request("GET", "/v1/keys")[1])
        self.assertEqual({"key": "a key", "value": "new"}, self.server.request("GET", "/v1/kv/a%20key")[1])
        status, payload, headers = self.server.request("DELETE", "/v1/kv/a%20key")
        self.assertEqual((204, None), (status, payload))
        self.assertEqual("application/json", headers["content-type"])
        self.assertEqual(404, self.server.request("GET", "/v1/kv/a%20key")[0])

    def test_health_validation_and_methods(self) -> None:
        self.assertEqual({"status": "ok"}, self.server.request("GET", "/health")[1])
        bad_cases = [
            ("/v1/kv/", {"value": 1}),
            ("/v1/kv/a%2Fb", {"value": 1}),
            ("/v1/kv/x", []),
            ("/v1/kv/x", {"ttl_seconds": 1}),
            ("/v1/kv/x", {"value": 1, "ttl_seconds": 0}),
            ("/v1/kv/x", {"value": 1, "ttl_seconds": True}),
            ("/v1/kv/x", {"value": 1, "ttl_seconds": None}),
            ("/v1/kv/x", {"value": 1, "extra": 2}),
        ]
        for path, document in bad_cases:
            with self.subTest(path=path, document=document):
                self.assertEqual(400, self.put(path, document)[0])
        status, payload, headers = self.server.request("TRACE", "/health")
        self.assertEqual(405, status)
        self.assertIsInstance(payload, dict)
        self.assertEqual("application/json", headers["content-type"])
        self.assertEqual(405, self.server.request("POST", "/health", b"")[0])
        self.assertEqual(404, self.server.request("GET", "/missing")[0])
        self.assertEqual(400, self.server.request("PUT", "/v1/kv/x", b"{")[0])
        self.assertEqual(400, self.server.request("PUT", "/v1/kv/x", b'{"value":NaN}')[0])
        self.assertEqual(201, self.server.request("PUT", "/v1/kv/surrogate", b'{"value":"\\ud800"}')[0])

    def test_ttl_persistence_restart_and_limit(self) -> None:
        self.assertEqual(201, self.put("/v1/kv/lasting", {"value": 7})[0])
        self.assertEqual(201, self.put("/v1/kv/brief", {"value": 8, "ttl_seconds": 0.08})[0])
        old_port = self.server.port
        self.server.close()
        self.server = RunningServer(self.data)
        self.assertNotEqual(0, old_port)
        self.assertEqual(7, self.server.request("GET", "/v1/kv/lasting")[1]["value"])
        time.sleep(0.12)
        self.assertEqual(404, self.server.request("GET", "/v1/kv/brief")[0])
        persisted = json.loads(self.data.read_text(encoding="utf-8"))
        self.assertNotIn("brief", persisted["entries"])
        oversized = b"x" * (1024 * 1024 + 1)
        status, payload, _headers = self.server.request(
            "PUT", "/v1/kv/large", oversized, {"Content-Length": str(len(oversized))}
        )
        self.assertEqual(413, status)
        self.assertIsInstance(payload, dict)


if __name__ == "__main__":
    unittest.main()
