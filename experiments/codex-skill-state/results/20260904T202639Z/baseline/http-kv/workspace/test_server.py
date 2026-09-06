"""Integration tests for server.py; uses only the Python standard library."""

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

    def request(self, method: str, path: str, body: object = None, raw: bytes | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        headers = {}
        payload = raw
        if raw is None and body is not None:
            payload = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        content = response.read()
        result = (response.status, dict(response.getheaders()), json.loads(content) if content else None)
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
        self.tempdir = tempfile.TemporaryDirectory()
        self.data = Path(self.tempdir.name) / "nested" / "store.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.stop()
        self.tempdir.cleanup()

    def test_crud_keys_and_validation(self):
        key = quote("snow ☃", safe="")
        status, headers, result = self.server.request("PUT", f"/v1/kv/{key}", {"value": [1, None]})
        self.assertEqual(status, 201)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(result["value"], [1, None])
        self.assertEqual(self.server.request("PUT", f"/v1/kv/{key}", {"value": 2})[0], 200)
        self.assertEqual(self.server.request("GET", f"/v1/kv/{key}")[2], {"key": "snow ☃", "value": 2})
        self.server.request("PUT", "/v1/kv/alpha", {"value": True})
        self.assertEqual(self.server.request("GET", "/v1/keys")[2], {"keys": ["alpha", "snow ☃"]})
        self.assertEqual(self.server.request("DELETE", f"/v1/kv/{key}")[0], 204)
        self.assertEqual(self.server.request("DELETE", f"/v1/kv/{key}")[0], 404)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/x", {"ttl_seconds": 2})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 10**400})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/x", raw=b"{" )[0], 400)
        self.assertEqual(self.server.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.server.request("BREW", "/health")[0], 405)
        self.assertEqual(self.server.request("GET", "/missing")[0], 404)

    def test_ttl_and_restart_persistence(self):
        self.server.request("PUT", "/v1/kv/lasting", {"value": {"x": 1}})
        self.server.request("PUT", "/v1/kv/brief", {"value": 2, "ttl_seconds": 0.15})
        time.sleep(0.25)
        self.assertEqual(self.server.request("GET", "/v1/kv/brief")[0], 404)
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.server.request("GET", "/v1/kv/lasting")[2]["value"], {"x": 1})
        self.assertEqual(self.server.request("GET", "/v1/kv/brief")[0], 404)
        persisted = json.loads(self.data.read_text())
        self.assertNotIn("brief", persisted["entries"])

    def test_concurrent_puts_and_body_limit(self):
        statuses: list[int] = []
        lock = threading.Lock()

        def write(index: int):
            status = self.server.request("PUT", f"/v1/kv/k{index:02d}", {"value": index})[0]
            with lock:
                statuses.append(status)

        threads = [threading.Thread(target=write, args=(index,)) for index in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 20)
        self.assertEqual(len(self.server.request("GET", "/v1/keys")[2]["keys"]), 20)
        too_large = b'"' + b"x" * (1024 * 1024) + b'"'
        self.assertEqual(self.server.request("PUT", "/v1/kv/large", raw=too_large)[0], 413)


if __name__ == "__main__":
    unittest.main()
