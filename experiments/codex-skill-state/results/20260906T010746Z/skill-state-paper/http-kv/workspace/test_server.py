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


class RunningServer:
    def __init__(self, data_path):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            raise RuntimeError(f"server did not start: {line!r} {self.process.stderr.read()!r}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        payload = None if body is None else json.dumps(body).encode()
        actual_headers = dict(headers or {})
        if payload is not None:
            actual_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=payload, headers=actual_headers)
        response = connection.getresponse()
        content = response.read()
        result = (response.status, dict(response.getheaders()), json.loads(content) if content else None)
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
        self.data = Path(self.temporary.name) / "store.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.stop()
        self.temporary.cleanup()

    def test_crud_keys_and_restart(self):
        key = "a key ☃"
        path = "/v1/kv/" + quote(key, safe="")
        status, headers, body = self.server.request("PUT", path, {"value": {"x": [1, True]}})
        self.assertEqual(201, status)
        self.assertEqual("application/json", headers["Content-Type"])
        self.assertEqual({"key": key, "value": {"x": [1, True]}}, body)
        self.assertEqual(200, self.server.request("PUT", path, {"value": "new"})[0])
        self.assertEqual({"key": key, "value": "new"}, self.server.request("GET", path)[2])
        self.assertEqual({"keys": [key]}, self.server.request("GET", "/v1/keys")[2])
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual({"key": key, "value": "new"}, self.server.request("GET", path)[2])
        self.assertEqual(204, self.server.request("DELETE", path)[0])
        self.assertEqual(404, self.server.request("GET", path)[0])

    def test_ttl_validation_routes_and_limit(self):
        path = "/v1/kv/short"
        self.assertEqual(201, self.server.request("PUT", path, {"value": 1, "ttl_seconds": 0.05})[0])
        time.sleep(0.08)
        self.assertEqual(404, self.server.request("GET", path)[0])
        self.assertEqual({"keys": []}, self.server.request("GET", "/v1/keys")[2])
        for ttl in (0, -1, True):
            self.assertEqual(400, self.server.request("PUT", path, {"value": 1, "ttl_seconds": ttl})[0])
        self.assertEqual(400, self.server.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0])
        self.assertEqual(405, self.server.request("POST", "/health", {})[0])
        self.assertEqual(404, self.server.request("GET", "/missing")[0])
        huge = b" " * (1024 * 1024 + 1)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request("PUT", path, body=huge, headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(413, response.status)
        response.read()
        connection.close()


if __name__ == "__main__":
    unittest.main()
