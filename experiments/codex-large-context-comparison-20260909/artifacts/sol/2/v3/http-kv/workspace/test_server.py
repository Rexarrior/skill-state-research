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


class RunningServer:
    def __init__(self, data: Path):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline()
        if not line.startswith("LISTENING "):
            stderr = self.process.stderr.read()
            raise RuntimeError(f"server failed: {line!r} {stderr}")
        self.port = int(line.split()[1])

    def close(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        stderr = self.process.stderr.read()
        self.process.stdout.close()
        self.process.stderr.close()
        assert self.process.returncode == 0, stderr

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        if body is not None and not isinstance(body, (bytes, str)):
            body = json.dumps(body, allow_nan=False)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        content_type = response.getheader("Content-Type")
        connection.close()
        payload = json.loads(raw) if raw else None
        return response.status, content_type, payload


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.data = Path(self.tempdir.name) / "nested" / "store.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.close()
        self.tempdir.cleanup()

    def restart(self):
        self.server.close()
        self.server = RunningServer(self.data)

    def test_crud_listing_and_persistence(self):
        key = "snow man ☃"
        path = "/v1/kv/" + quote(key, safe="")
        status, content_type, payload = self.server.request("PUT", path, {"value": {"n": 1}})
        self.assertEqual((status, content_type), (201, "application/json"))
        self.assertEqual(payload, {"key": key, "value": {"n": 1}})
        self.assertEqual(self.server.request("PUT", path, {"value": [2]})[0], 200)
        self.assertEqual(self.server.request("GET", path)[2], {"key": key, "value": [2]})
        self.server.request("PUT", "/v1/kv/a", {"value": None})
        self.assertEqual(self.server.request("GET", "/v1/keys")[2], {"keys": ["a", key]})
        self.restart()
        self.assertEqual(self.server.request("GET", path)[2]["value"], [2])
        self.assertEqual(self.server.request("DELETE", path)[0], 204)
        self.assertEqual(self.server.request("GET", path)[0], 404)
        self.assertEqual(self.server.request("DELETE", path)[0], 404)

    def test_ttl_expires_and_stays_gone(self):
        self.assertEqual(
            self.server.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.15})[0],
            201,
        )
        time.sleep(0.25)
        self.assertEqual(self.server.request("GET", "/v1/kv/short")[0], 404)
        self.restart()
        self.assertEqual(self.server.request("GET", "/v1/kv/short")[0], 404)

    def test_errors_and_health(self):
        self.assertEqual(self.server.request("GET", "/health")[2], {"status": "ok"})
        cases = [
            ("PUT", "/v1/kv/x", b"{"),
            ("PUT", "/v1/kv/x", []),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0}),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": None}),
            ("PUT", "/v1/kv/x", {"value": 1, "extra": 2}),
            ("PUT", "/v1/kv/", {"value": 1}),
            ("PUT", "/v1/kv/a%2Fb", {"value": 1}),
        ]
        for method, path, body in cases:
            with self.subTest(path=path, body=body):
                status, content_type, payload = self.server.request(method, path, body)
                self.assertEqual(status, 400)
                self.assertEqual(content_type, "application/json")
                self.assertIn("error", payload)
        self.assertEqual(self.server.request("GET", "/missing")[0], 404)
        self.assertEqual(self.server.request("POST", "/health", {})[0], 405)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.putrequest("PUT", "/v1/kv/big")
        connection.putheader("Content-Length", str(1024 * 1024 + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        self.assertIn("error", json.loads(response.read()))
        connection.close()

    def test_concurrent_writes(self):
        results = []

        def write(index):
            results.append(self.server.request("PUT", f"/v1/kv/k{index}", {"value": index})[0])

        threads = [threading.Thread(target=write, args=(i,)) for i in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results, [201] * 12)
        self.restart()
        self.assertEqual(len(self.server.request("GET", "/v1/keys")[2]["keys"]), 12)


if __name__ == "__main__":
    unittest.main()
