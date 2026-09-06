#!/usr/bin/env python3
"""Integration self-tests for server.py."""

from __future__ import annotations

import http.client
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
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
            self.stop()
            raise RuntimeError(f"server did not start: {line!r}")
        self.port = int(line.split()[1])

    def request(self, method: str, path: str, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        request_headers = dict(headers or {})
        encoded = body
        if body is not None and not isinstance(body, (bytes, str)):
            encoded = json.dumps(body)
            request_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, dict(response.getheaders()), json.loads(raw) if raw else None)
        connection.close()
        return result

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)


class ServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "store.json"
        self.server = RunningServer(self.data)

    def tearDown(self) -> None:
        self.server.stop()
        self.temp.cleanup()

    def test_crud_keys_and_encoded_key(self) -> None:
        key = "hello world-λ"
        path = "/v1/kv/" + quote(key, safe="")
        status, headers, result = self.server.request("PUT", path, {"value": {"n": 1}})
        self.assertEqual(status, 201)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(result, {"key": key, "value": {"n": 1}})
        self.assertEqual(self.server.request("PUT", path, {"value": None})[0], 200)
        self.assertEqual(self.server.request("GET", path)[2], {"key": key, "value": None})
        self.server.request("PUT", "/v1/kv/a", {"value": 2})
        self.assertEqual(self.server.request("GET", "/v1/keys")[2], {"keys": ["a", key]})
        self.assertEqual(self.server.request("DELETE", path)[0], 204)
        self.assertEqual(self.server.request("DELETE", path)[0], 404)

    def test_ttl_and_restart_persistence(self) -> None:
        self.assertEqual(self.server.request("PUT", "/v1/kv/live", {"value": [1, 2]})[0], 201)
        self.assertEqual(self.server.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.12})[0], 201)
        time.sleep(0.2)
        self.assertEqual(self.server.request("GET", "/v1/kv/short")[0], 404)
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.server.request("GET", "/v1/kv/live")[2]["value"], [1, 2])
        self.assertEqual(self.server.request("GET", "/v1/kv/short")[0], 404)

    def test_health_errors_and_body_limit(self) -> None:
        self.assertEqual(self.server.request("GET", "/health")[2], {"status": "ok"})
        cases = [
            ("PUT", "/v1/kv/x", b"{"),
            ("PUT", "/v1/kv/x", []),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0}),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": True}),
            ("GET", "/unknown", None),
            ("POST", "/health", None),
            ("GET", "/v1/kv/a%2Fb", None),
            ("GET", "/v1/kv/%FF", None),
        ]
        for method, path, body in cases:
            status, headers, result = self.server.request(method, path, body)
            self.assertTrue(400 <= status < 500, (method, path, status))
            self.assertEqual(headers["Content-Type"], "application/json")
            self.assertIn("error", result)
        status, _, _ = self.server.request(
            "PUT", "/v1/kv/x", b"x", {"Content-Length": str(1024 * 1024 + 1)}
        )
        self.assertEqual(status, 413)

    def test_concurrent_writes(self) -> None:
        errors = []

        def write(index: int) -> None:
            try:
                status, _, _ = self.server.request("PUT", f"/v1/kv/k{index:02d}", {"value": index})
                if status != 201:
                    errors.append(status)
            except Exception as exc:  # pragma: no cover - diagnostic collection
                errors.append(exc)

        threads = [threading.Thread(target=write, args=(index,)) for index in range(30)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(self.server.request("GET", "/v1/keys")[2]["keys"]), 30)
        with self.data.open(encoding="utf-8") as source:
            self.assertEqual(len(json.load(source)["entries"]), 30)


if __name__ == "__main__":
    unittest.main(verbosity=2)
