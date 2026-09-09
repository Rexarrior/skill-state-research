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


ROOT = Path(__file__).parent


class Service:
    def __init__(self, data: Path):
        self.data = data
        self.process = None
        self.port = None

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            raise AssertionError(f"server failed to start: {line!r} {self.process.stderr.read()}")
        self.port = int(line.split()[1])
        return self

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        if self.process is not None:
            self.process.stdout.close()
            self.process.stderr.close()

    def request(self, method, path, document=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        body = raw
        request_headers = dict(headers or {})
        if document is not None:
            body = json.dumps(document).encode()
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, dict(response.getheaders()), payload)
        connection.close()
        return result


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data = Path(self.temporary.name) / "nested" / "store.json"
        self.service = Service(self.data).start()

    def tearDown(self):
        self.service.stop()
        self.temporary.cleanup()

    def json_request(self, *args, **kwargs):
        status, headers, body = self.service.request(*args, **kwargs)
        parsed = None if not body else json.loads(body)
        if body:
            self.assertEqual(headers.get("Content-Type"), "application/json")
        return status, parsed

    def test_crud_keys_and_restart(self):
        key = "hello world+雪"
        path = "/v1/kv/" + quote(key, safe="")
        self.assertEqual(self.json_request("PUT", path, {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.json_request("PUT", path, {"value": [2, None]})[0], 200)
        self.assertEqual(self.json_request("GET", path), (200, {"key": key, "value": [2, None]}))
        self.assertEqual(self.json_request("GET", "/v1/keys"), (200, {"keys": [key]}))
        self.service.stop()
        self.service = Service(self.data).start()
        self.assertEqual(self.json_request("GET", path)[0], 200)
        status, headers, body = self.service.request("DELETE", path)
        self.assertEqual((status, body), (204, b""))
        self.assertEqual(headers.get("Content-Type"), "application/json")
        self.assertEqual(self.json_request("GET", path)[0], 404)

    def test_ttl_expires_and_stays_gone(self):
        self.assertEqual(self.json_request("PUT", "/v1/kv/brief", {"value": 1, "ttl_seconds": 0.08})[0], 201)
        time.sleep(0.12)
        self.assertEqual(self.json_request("GET", "/v1/kv/brief")[0], 404)
        self.service.stop()
        self.service = Service(self.data).start()
        self.assertEqual(self.json_request("GET", "/v1/keys"), (200, {"keys": []}))

    def test_errors_health_and_limit(self):
        self.assertEqual(self.json_request("GET", "/health"), (200, {"status": "ok"}))
        cases = [
            ("PUT", "/v1/kv/x", {}, None),
            ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0}, None),
            ("PUT", "/v1/kv/x", None, b"{"),
            ("GET", "/v1/kv/a%2Fb", None, None),
            ("GET", "/missing", None, None),
            ("POST", "/health", None, b""),
            ("TRACE", "/health", None, None),
        ]
        expected = [400, 400, 400, 400, 404, 405, 405]
        for request, wanted in zip(cases, expected):
            method, path, document, raw = request
            with self.subTest(method=method, path=path):
                self.assertEqual(self.json_request(method, path, document, raw)[0], wanted)
        status, _, _ = self.service.request(
            "PUT", "/v1/kv/x", raw=b"", headers={"Content-Length": str(1024 * 1024 + 1)}
        )
        self.assertEqual(status, 413)


if __name__ == "__main__":
    unittest.main()
