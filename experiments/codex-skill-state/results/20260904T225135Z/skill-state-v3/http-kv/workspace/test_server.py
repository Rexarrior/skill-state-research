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
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise RuntimeError(f"server did not start: {line!r} {stderr}")
        self.port = int(line.split()[1])

    def request(self, method: str, path: str, body: object | bytes | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        headers = {}
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, dict(response.headers), json.loads(raw) if raw else None)
        connection.close()
        return result

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
        self.tempdir = tempfile.TemporaryDirectory()
        self.data = Path(self.tempdir.name) / "state.json"
        self.server = RunningServer(self.data)

    def tearDown(self) -> None:
        self.server.close()
        self.tempdir.cleanup()

    def test_crud_keys_and_persistence(self) -> None:
        key = "snow man ☃"
        path = "/v1/kv/" + quote(key, safe="")
        status, headers, result = self.server.request("PUT", path, {"value": {"n": 1}})
        self.assertEqual(status, 201)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(result["value"], {"n": 1})
        self.assertEqual(self.server.request("PUT", path, {"value": None})[0], 200)
        self.assertEqual(self.server.request("GET", path)[2], {"key": key, "value": None})
        self.assertEqual(self.server.request("GET", "/v1/keys")[2], {"keys": [key]})

        self.server.close()
        self.server = RunningServer(self.data)
        self.assertEqual(self.server.request("GET", path)[2], {"key": key, "value": None})
        self.assertEqual(self.server.request("DELETE", path)[0], 204)
        self.assertEqual(self.server.request("GET", path)[0], 404)

    def test_ttl_validation_routes_and_body_limit(self) -> None:
        path = "/v1/kv/short"
        self.assertEqual(self.server.request("PUT", path, {"value": 1, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.08)
        self.assertEqual(self.server.request("GET", path)[0], 404)
        self.assertEqual(self.server.request("PUT", path, {"value": 1, "ttl_seconds": True})[0], 400)
        self.assertEqual(self.server.request("PUT", path, [1])[0], 400)
        self.assertEqual(self.server.request("PUT", path, b"{")[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        self.assertEqual(self.server.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.server.request("GET", "/missing")[0], 404)
        self.assertEqual(self.server.request("PUT", path, b" " * (1024 * 1024 + 1))[0], 413)

    def test_health_and_sorted_keys(self) -> None:
        self.assertEqual(self.server.request("GET", "/health")[2], {"status": "ok"})
        for key in ("z", "a", "middle"):
            self.assertEqual(self.server.request("PUT", f"/v1/kv/{key}", {"value": key})[0], 201)
        self.assertEqual(self.server.request("GET", "/v1/keys")[2], {"keys": ["a", "middle", "z"]})


if __name__ == "__main__":
    unittest.main()
