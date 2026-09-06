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


ROOT = Path(__file__).parent


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
            raise RuntimeError(f"server did not start: {line!r} {stderr!r}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = body if isinstance(body, bytes) else (None if body is None else json.dumps(body).encode())
        request_headers = dict(headers or {})
        if encoded is not None:
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, encoded, request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, response.getheader("Content-Type"), raw)
        connection.close()
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data = Path(self.temporary.name) / "state.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.close()
        self.temporary.cleanup()

    def json_request(self, method, path, body=None):
        status, content_type, raw = self.server.request(method, path, body)
        self.assertEqual(content_type, "application/json")
        return status, json.loads(raw) if raw else None

    def test_crud_keys_and_encoded_key(self):
        key = "snow man ☃"
        path = "/v1/kv/" + quote(key, safe="")
        self.assertEqual(self.json_request("PUT", path, {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.json_request("PUT", path, {"value": None})[0], 200)
        self.assertEqual(self.json_request("GET", path), (200, {"key": key, "value": None}))
        self.assertEqual(self.json_request("GET", "/v1/keys"), (200, {"keys": [key]}))
        self.assertEqual(self.json_request("DELETE", path), (204, None))
        self.assertEqual(self.json_request("GET", path)[0], 404)

    def test_ttl_and_restart_persistence(self):
        self.json_request("PUT", "/v1/kv/permanent", {"value": 7})
        self.json_request("PUT", "/v1/kv/short", {"value": 8, "ttl_seconds": 0.12})
        time.sleep(0.2)
        self.assertEqual(self.json_request("GET", "/v1/kv/short")[0], 404)
        self.server.close()
        self.server = RunningServer(self.data)
        self.assertEqual(self.json_request("GET", "/v1/kv/permanent")[1]["value"], 7)
        self.assertEqual(self.json_request("GET", "/v1/kv/short")[0], 404)

    def test_errors_and_limit(self):
        for ttl in (0, -1, True, "1"):
            self.assertEqual(self.json_request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.json_request("GET", "/v1/kv/a%2Fb")[0], 400)
        self.assertEqual(self.json_request("POST", "/health", {})[0], 405)
        status, _, _ = self.server.request(
            "PUT", "/v1/kv/large", b"", {"Content-Length": str(1024 * 1024 + 1)}
        )
        self.assertEqual(status, 413)

    def test_concurrent_writes(self):
        errors = []
        def write(index):
            try:
                status, _ = self.json_request("PUT", f"/v1/kv/k{index:02}", {"value": index})
                if status != 201:
                    errors.append(status)
            except Exception as exc:
                errors.append(exc)
        threads = [threading.Thread(target=write, args=(index,)) for index in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        status, result = self.json_request("GET", "/v1/keys")
        self.assertEqual(status, 200)
        self.assertEqual(result["keys"], [f"k{index:02}" for index in range(20)])


if __name__ == "__main__":
    unittest.main()
