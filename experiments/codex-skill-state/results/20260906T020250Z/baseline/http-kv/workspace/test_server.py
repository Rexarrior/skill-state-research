import http.client
import concurrent.futures
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
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            stderr = self.process.stderr.read()
            raise RuntimeError(f"server failed to start: {line!r} {stderr!r}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
                headers = {"Content-Type": "application/json", **(headers or {})}
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            raw = response.read()
            return (response.status, dict(response.headers), json.loads(raw) if raw else None)
        finally:
            connection.close()

    def close(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=3)
        self.process.stdout.close()
        self.process.stderr.close()


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data = Path(self.temporary.name) / "state.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.close()
        self.temporary.cleanup()

    def test_crud_sorting_and_encoded_key(self):
        key = "snow ☃"
        path = "/v1/kv/" + quote(key)
        self.assertEqual(self.server.request("PUT", path, {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.server.request("PUT", path, {"value": None})[0], 200)
        status, headers, body = self.server.request("GET", path)
        self.assertEqual((status, body), (200, {"key": key, "value": None}))
        self.assertEqual(headers["Content-Type"], "application/json")
        self.server.request("PUT", "/v1/kv/a", {"value": 1})
        self.assertEqual(self.server.request("GET", "/v1/keys")[2], {"keys": ["a", key]})
        self.assertEqual(self.server.request("DELETE", path)[0], 204)
        self.assertEqual(self.server.request("GET", path)[0], 404)

    def test_ttl_and_restart(self):
        self.server.request("PUT", "/v1/kv/lasting", {"value": "yes"})
        self.server.request("PUT", "/v1/kv/brief", {"value": "no", "ttl_seconds": 0.08})
        time.sleep(0.12)
        self.server.close()
        self.server = RunningServer(self.data)
        self.assertEqual(self.server.request("GET", "/v1/kv/brief")[0], 404)
        self.assertEqual(self.server.request("GET", "/v1/kv/lasting")[2]["value"], "yes")
        self.assertEqual(self.server.request("GET", "/v1/keys")[2], {"keys": ["lasting"]})

    def test_validation_and_methods(self):
        cases = [
            ("PUT", "/v1/kv/x", b"not-json", {}, 400),
            ("PUT", "/v1/kv/x", b"null", {}, 400),
            ("PUT", "/v1/kv/x", {"ttl_seconds": 1}, None, 400),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0}, None, 400),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": True}, None, 400),
            ("GET", "/v1/kv/%2F", None, None, 400),
            ("POST", "/health", None, None, 405),
            ("BREW", "/health", None, None, 405),
            ("PUT", "/health", {}, None, 405),
            ("GET", "/missing", None, None, 404),
        ]
        for method, path, body, headers, expected in cases:
            with self.subTest(method=method, path=path, body=body):
                status, response_headers, response_body = self.server.request(method, path, body, headers)
                self.assertEqual(status, expected)
                self.assertEqual(response_headers["Content-Type"], "application/json")
                self.assertIn("error", response_body)

        huge = b"x" * (1024 * 1024 + 1)
        self.assertEqual(self.server.request("PUT", "/v1/kv/x", huge)[0], 413)

    def test_concurrent_writes_are_not_lost(self):
        def put(index):
            return self.server.request("PUT", f"/v1/kv/k{index:02d}", {"value": index})[0]

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            statuses = list(executor.map(put, range(24)))
        self.assertEqual(statuses, [201] * 24)
        keys = self.server.request("GET", "/v1/keys")[2]["keys"]
        self.assertEqual(keys, [f"k{index:02d}" for index in range(24)])
        with self.data.open(encoding="utf-8") as stream:
            self.assertEqual(len(json.load(stream)["entries"]), 24)


if __name__ == "__main__":
    unittest.main()
