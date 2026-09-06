from __future__ import annotations

import http.client
import json
import os
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
    def __init__(self, data_path: Path):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data_path)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise RuntimeError(f"server failed to start: {line!r} {stderr}")
        self.port = int(line.split()[1])

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        if self.process.stderr:
            self.process.stderr.close()
        if self.process.stdout:
            self.process.stdout.close()


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "state.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        payload = None if body is None else json.dumps(body, allow_nan=False).encode()
        request_headers = {} if headers is None else dict(headers)
        if payload is not None:
            request_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, payload, request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, response.getheader("Content-Type"), json.loads(raw) if raw else None)
        connection.close()
        return result

    def test_crud_unicode_keys_and_sorted_listing(self):
        key = "two words ☃"
        path = "/v1/kv/" + quote(key)
        self.assertEqual(self.request("PUT", path, {"value": [1, None]})[0], 201)
        self.assertEqual(self.request("PUT", path, {"value": False})[0], 200)
        self.assertEqual(self.request("PUT", "/v1/kv/aaa", {"value": 2})[0], 201)
        self.assertEqual(self.request("GET", path)[2], {"key": key, "value": False})
        self.assertEqual(self.request("GET", "/v1/keys")[2], {"keys": ["aaa", key]})
        self.assertEqual(self.request("DELETE", path)[0], 204)
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_ttl_expires_and_is_removed_from_disk(self):
        self.assertEqual(self.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.08)
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)
        self.assertNotIn("short", self.data.read_text(encoding="utf-8"))

    def test_persistence_across_restart(self):
        self.request("PUT", "/v1/kv/saved", {"value": {"yes": True}})
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.request("GET", "/v1/kv/saved")[2]["value"], {"yes": True})

    def test_errors_and_body_limit(self):
        for body in (
            {},
            [],
            {"value": 1, "ttl_seconds": 0},
            {"value": 1, "ttl_seconds": True},
            {"value": 1, "ttl_seconds": None},
            {"value": 1, "ttl_seconds": 10**1000},
        ):
            self.assertEqual(self.request("PUT", "/v1/kv/x", body)[0], 400)
        self.assertEqual(self.request("GET", "/v1/kv/%2F")[0], 400)
        self.assertEqual(self.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.request("PUT", "/health", {})[0], 405)
        self.assertEqual(self.request("POST", "/unknown", {})[0], 404)
        status, content_type, error = self.request("BREW", "/health")
        self.assertEqual((status, content_type), (405, "application/json"))
        self.assertIn("error", error)
        self.assertEqual(self.request("GET", "/unknown")[0], 404)
        status = self.request("PUT", "/v1/kv/large", None, {"Content-Length": str(1024 * 1024 + 1)})[0]
        self.assertEqual(status, 413)

        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        nested = b'{"value":' + b"[" * 2000 + b"]" * 2000 + b"}"
        connection.request("PUT", "/v1/kv/deep", nested)
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        self.assertIn("error", json.loads(response.read()))
        connection.close()

    def test_escaped_lone_surrogate_is_safe(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request("PUT", "/v1/kv/surrogate", b'{"value":"\\ud800"}')
        response = connection.getresponse()
        self.assertEqual(response.status, 201)
        self.assertEqual(json.loads(response.read())["value"], "\ud800")
        connection.close()
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.request("GET", "/v1/kv/surrogate")[2]["value"], "\ud800")

    def test_concurrent_writes_are_not_lost(self):
        statuses = []

        def put(index):
            statuses.append(self.request("PUT", f"/v1/kv/k{index}", {"value": index})[0])

        threads = [threading.Thread(target=put, args=(index,)) for index in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 20)
        keys = self.request("GET", "/v1/keys")[2]["keys"]
        self.assertEqual(keys, sorted(f"k{index}" for index in range(20)))


if __name__ == "__main__":
    unittest.main()
