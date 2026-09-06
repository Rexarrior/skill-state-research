import http.client
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent


class RunningServer:
    def __init__(self, data_path):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data_path)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            stderr = self.process.stderr.read()
            raise RuntimeError(f"server failed: {line!r} {stderr!r}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = body if isinstance(body, bytes) else (None if body is None else json.dumps(body).encode())
        request_headers = dict(headers or {})
        if encoded is not None:
            request_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, response.getheader("Content-Type"), payload)
        connection.close()
        return result

    def stop(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "store.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.stop()
        self.temp.cleanup()

    def json_request(self, method, path, body=None):
        status, content_type, payload = self.server.request(method, path, body)
        parsed = json.loads(payload) if payload else None
        return status, content_type, parsed

    def test_crud_keys_and_encoded_key(self):
        key = "snow ☃"
        path = "/v1/kv/" + quote(key, safe="")
        status, content_type, body = self.json_request("PUT", path, {"value": {"n": 1}})
        self.assertEqual(201, status)
        self.assertEqual("application/json", content_type)
        self.assertEqual({"key": key, "value": {"n": 1}}, body)
        self.assertEqual(200, self.json_request("PUT", path, {"value": None})[0])
        self.assertEqual({"key": key, "value": None}, self.json_request("GET", path)[2])
        self.assertEqual({"keys": [key]}, self.json_request("GET", "/v1/keys")[2])
        self.assertEqual(204, self.server.request("DELETE", path)[0])
        self.assertEqual(404, self.json_request("GET", path)[0])

    def test_ttl_and_validation(self):
        self.assertEqual(201, self.json_request("PUT", "/v1/kv/short", {"value": 3, "ttl_seconds": 0.08})[0])
        time.sleep(0.12)
        self.assertEqual(404, self.json_request("GET", "/v1/kv/short")[0])
        for ttl in (0, -1, True):
            self.assertEqual(400, self.json_request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl})[0])
        self.assertEqual(400, self.json_request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0])
        self.assertEqual(400, self.json_request("PUT", "/v1/kv/x", [1, 2])[0])

    def test_persistence_across_restart(self):
        self.assertEqual(201, self.json_request("PUT", "/v1/kv/durable", {"value": "yes"})[0])
        self.assertEqual(201, self.json_request("PUT", "/v1/kv/expiring", {"value": "no", "ttl_seconds": 0.08})[0])
        time.sleep(0.12)
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual({"key": "durable", "value": "yes"}, self.json_request("GET", "/v1/kv/durable")[2])
        self.assertEqual(404, self.json_request("GET", "/v1/kv/expiring")[0])

    def test_concurrent_writes_are_not_lost(self):
        def put(index):
            return self.json_request("PUT", f"/v1/kv/k{index:02d}", {"value": index})[0]

        with ThreadPoolExecutor(max_workers=8) as executor:
            statuses = list(executor.map(put, range(24)))
        self.assertEqual([201] * 24, statuses)
        self.assertEqual([f"k{index:02d}" for index in range(24)], self.json_request("GET", "/v1/keys")[2]["keys"])

    def test_errors_health_and_limit(self):
        self.assertEqual({"status": "ok"}, self.json_request("GET", "/health")[2])
        self.assertEqual(404, self.json_request("GET", "/missing")[0])
        self.assertEqual(405, self.json_request("POST", "/health", {})[0])
        self.assertEqual(405, self.json_request("PUT", "/health", {})[0])
        status, content_type, _ = self.server.request("BREW", "/health")
        self.assertEqual(405, status)
        self.assertEqual("application/json", content_type)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.putrequest("PUT", "/v1/kv/x")
        connection.putheader("Content-Length", str(1024 * 1024 + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(413, response.status)
        self.assertTrue(response.read())
        connection.close()


if __name__ == "__main__":
    unittest.main()
