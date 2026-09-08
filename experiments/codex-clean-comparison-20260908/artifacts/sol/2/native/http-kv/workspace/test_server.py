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
        line = self.process.stdout.readline()
        if not line.startswith("LISTENING "):
            stderr = self.process.stderr.read()
            raise RuntimeError(f"server failed to start: {line!r} {stderr}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        if body is not None and not isinstance(body, (bytes, str)):
            body = json.dumps(body)
            headers = {"Content-Type": "application/json", **(headers or {})}
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, dict(response.getheaders()), payload)
        connection.close()
        return result

    def stop(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data = Path(self.temporary.name) / "nested" / "state.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.stop()
        self.temporary.cleanup()

    def json_request(self, method, path, body=None):
        status, headers, payload = self.server.request(method, path, body)
        document = json.loads(payload) if payload else None
        return status, headers, document

    def test_crud_keys_and_encoded_key(self):
        status, _, body = self.json_request("PUT", "/v1/kv/hello%20world", {"value": [1, None]})
        self.assertEqual(201, status)
        self.assertEqual({"key": "hello world", "value": [1, None]}, body)
        self.assertEqual(200, self.json_request("PUT", "/v1/kv/hello%20world", {"value": 2})[0])
        self.assertEqual({"key": "hello world", "value": 2}, self.json_request("GET", "/v1/kv/hello%20world")[2])
        self.json_request("PUT", "/v1/kv/alpha", {"value": True})
        self.assertEqual({"keys": ["alpha", "hello world"]}, self.json_request("GET", "/v1/keys")[2])
        status, headers, body = self.json_request("DELETE", "/v1/kv/alpha")
        self.assertEqual(204, status)
        self.assertEqual("application/json", headers["Content-Type"])
        self.assertIsNone(body)
        self.assertEqual(404, self.json_request("GET", "/v1/kv/alpha")[0])

    def test_ttl_and_restart_persistence(self):
        self.json_request("PUT", "/v1/kv/permanent", {"value": {"x": 1}})
        self.json_request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.1})
        time.sleep(0.15)
        self.assertEqual(404, self.json_request("GET", "/v1/kv/short")[0])
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual({"key": "permanent", "value": {"x": 1}}, self.json_request("GET", "/v1/kv/permanent")[2])
        self.assertEqual({"keys": ["permanent"]}, self.json_request("GET", "/v1/keys")[2])

    def test_validation_and_errors_are_json(self):
        cases = [
            ("PUT", "/v1/kv/key", b"{"),
            ("PUT", "/v1/kv/key", b"null"),
            ("PUT", "/v1/kv/key", []),
            ("PUT", "/v1/kv/key", {"value": 1, "ttl_seconds": 0}),
            ("PUT", "/v1/kv/key", {"value": 1, "ttl_seconds": None}),
            ("PUT", "/v1/kv/key", {"value": 1, "ttl_seconds": True}),
            ("PUT", "/v1/kv/%2F", {"value": 1}),
            ("GET", "/missing", None),
            ("POST", "/health", b""),
            ("FROB", "/health", None),
        ]
        for method, path, body in cases:
            with self.subTest(method=method, path=path, body=body):
                status, headers, payload = self.server.request(method, path, body)
                self.assertTrue(400 <= status < 500)
                self.assertEqual("application/json", headers["Content-Type"])
                self.assertIn("error", json.loads(payload))
        status, _, _ = self.server.request(
            "PUT", "/v1/kv/large", b"x" * (1024 * 1024 + 1), {"Content-Type": "application/json"}
        )
        self.assertEqual(413, status)

    def test_concurrent_writes_remain_valid(self):
        failures = []

        def write(number):
            try:
                status, _, _ = self.json_request("PUT", f"/v1/kv/k{number:02d}", {"value": number})
                if status != 201:
                    failures.append(status)
            except Exception as exc:
                failures.append(exc)

        threads = [threading.Thread(target=write, args=(number,)) for number in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual([], failures)
        with self.data.open(encoding="utf-8") as source:
            self.assertEqual(20, len(json.load(source)["entries"]))


if __name__ == "__main__":
    unittest.main()
