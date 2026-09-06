#!/usr/bin/env python3
"""Dependency-free integration tests for server.py."""

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
    def __init__(self, data_file: Path):
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "server.py"),
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--data",
                str(data_file),
            ],
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

    def request(self, method: str, path: str, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        request_headers = dict(headers or {})
        encoded = body
        if body is not None and not isinstance(body, (bytes, str)):
            encoded = json.dumps(body, separators=(",", ":"))
            request_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, dict(response.getheaders()), raw)
        connection.close()
        return result

    def stop(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data_file = Path(self.temporary.name) / "nested" / "data.json"
        self.server = RunningServer(self.data_file)

    def tearDown(self):
        self.server.stop()
        self.temporary.cleanup()

    @staticmethod
    def decoded(response):
        status, headers, raw = response
        body = None if not raw else json.loads(raw)
        return status, headers, body

    def test_crud_sorting_validation_and_limit(self):
        key = "hello world"
        path = "/v1/kv/" + quote(key, safe="")
        status, headers, body = self.decoded(
            self.server.request("PUT", path, {"value": {"answer": 42}})
        )
        self.assertEqual(201, status)
        self.assertEqual("application/json", headers["Content-Type"])
        self.assertEqual({"key": key, "value": {"answer": 42}}, body)

        status, _, _ = self.decoded(
            self.server.request("PUT", path, {"value": [1, None, True]})
        )
        self.assertEqual(200, status)
        self.assertEqual(
            (200, {"key": key, "value": [1, None, True]}),
            (lambda r: (r[0], r[2]))(self.decoded(self.server.request("GET", path))),
        )
        self.server.request("PUT", "/v1/kv/z", {"value": 1})
        self.server.request("PUT", "/v1/kv/a", {"value": 1})
        self.assertEqual(
            {"keys": ["a", "hello world", "z"]},
            self.decoded(self.server.request("GET", "/v1/keys"))[2],
        )

        invalid_cases = [
            ("PUT", "/v1/kv/", {"value": 1}),
            ("PUT", "/v1/kv/a%2Fb", {"value": 1}),
            ("PUT", "/v1/kv/x", []),
            ("PUT", "/v1/kv/x", {"ttl_seconds": 1}),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0}),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": True}),
        ]
        for method, invalid_path, invalid_body in invalid_cases:
            with self.subTest(path=invalid_path, body=invalid_body):
                status, _, body = self.decoded(
                    self.server.request(method, invalid_path, invalid_body)
                )
                self.assertEqual(400, status)
                self.assertIn("error", body)

        self.assertEqual(
            400,
            self.server.request(
                "PUT", "/v1/kv/x", b"{bad", {"Content-Type": "application/json"}
            )[0],
        )
        self.assertEqual(
            413,
            self.server.request("PUT", "/v1/kv/x", b"x" * (1024 * 1024 + 1))[0],
        )
        self.assertEqual(405, self.server.request("POST", "/health", b"")[0])
        self.assertEqual(404, self.server.request("GET", "/missing")[0])

        status, headers, raw = self.server.request("DELETE", path)
        self.assertEqual(204, status)
        self.assertEqual(b"", raw)
        self.assertEqual("application/json", headers["Content-Type"])
        self.assertEqual(404, self.server.request("DELETE", path)[0])

    def test_ttl_persistence_restart_and_health(self):
        self.assertEqual(
            {"status": "ok"},
            self.decoded(self.server.request("GET", "/health"))[2],
        )
        self.assertEqual(
            201,
            self.server.request("PUT", "/v1/kv/durable", {"value": "yes"})[0],
        )
        self.assertEqual(
            201,
            self.server.request(
                "PUT", "/v1/kv/short", {"value": "gone", "ttl_seconds": 0.15}
            )[0],
        )
        self.server.stop()
        time.sleep(0.25)
        self.server = RunningServer(self.data_file)
        self.assertEqual(200, self.server.request("GET", "/v1/kv/durable")[0])
        self.assertEqual(404, self.server.request("GET", "/v1/kv/short")[0])
        self.assertEqual(
            {"keys": ["durable"]},
            self.decoded(self.server.request("GET", "/v1/keys"))[2],
        )
        persisted = json.loads(self.data_file.read_text(encoding="utf-8"))
        self.assertNotIn("short", persisted["entries"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
