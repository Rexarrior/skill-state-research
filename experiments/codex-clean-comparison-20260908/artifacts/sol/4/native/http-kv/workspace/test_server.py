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
            raise RuntimeError(f"server failed to start: {line!r} {stderr}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        payload = None if body is None else json.dumps(body, separators=(",", ":"))
        connection.request(method, path, payload, headers or {})
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, response.getheader("Content-Type"), raw)
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

    def json_request(self, method, path, body=None):
        status, content_type, raw = self.server.request(method, path, body)
        parsed = None if not raw else json.loads(raw)
        return status, content_type, parsed

    def test_crud_encoded_keys_and_sorted_listing(self):
        key = "snow ☃"
        path = "/v1/kv/" + quote(key, safe="")
        self.assertEqual(self.json_request("PUT", path, {"value": [1, None]})[0], 201)
        self.assertEqual(self.json_request("PUT", path, {"value": "new"})[0], 200)
        self.assertEqual(self.json_request("PUT", "/v1/kv/alpha", {"value": 1})[0], 201)
        status, content_type, result = self.json_request("GET", path)
        self.assertEqual((status, content_type), (200, "application/json"))
        self.assertEqual(result, {"key": key, "value": "new"})
        self.assertEqual(self.json_request("GET", "/v1/keys")[2], {"keys": ["alpha", key]})
        self.assertEqual(self.json_request("DELETE", path)[0], 204)
        self.assertEqual(self.json_request("GET", path)[0], 404)

    def test_ttl_and_validation(self):
        self.assertEqual(self.json_request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.08)
        self.assertEqual(self.json_request("GET", "/v1/kv/x")[0], 404)
        for ttl in (0, -1, True, "1"):
            self.assertEqual(self.json_request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.json_request("PUT", "/v1/kv/", {"value": 1})[0], 400)
        self.assertEqual(self.json_request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        huge_integer = int("9" * 400)
        self.assertEqual(
            self.json_request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": huge_integer})[0],
            400,
        )

    def test_concurrent_writes_are_all_persisted(self):
        def write(number):
            return self.json_request(
                "PUT", f"/v1/kv/key-{number:02d}", {"value": number}
            )[0]

        with ThreadPoolExecutor(max_workers=8) as executor:
            statuses = list(executor.map(write, range(24)))
        self.assertEqual(statuses, [201] * 24)
        self.server.stop()
        self.server = RunningServer(self.data)
        keys = self.json_request("GET", "/v1/keys")[2]["keys"]
        self.assertEqual(keys, [f"key-{number:02d}" for number in range(24)])

    def test_restart_persistence_and_health(self):
        self.assertEqual(self.json_request("PUT", "/v1/kv/kept", {"value": {"ok": True}})[0], 201)
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.json_request("GET", "/v1/kv/kept")[2]["value"], {"ok": True})
        self.assertEqual(self.json_request("GET", "/health")[2], {"status": "ok"})

    def test_errors_and_body_limit(self):
        self.assertEqual(self.json_request("GET", "/missing")[0], 404)
        self.assertEqual(self.json_request("POST", "/health", {})[0], 405)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request("PUT", "/v1/kv/x", b"{", {"Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        response.read()
        connection.close()
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request(
            "PUT", "/v1/kv/large", b"x", {"Content-Length": str(1024 * 1024 + 1)}
        )
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        connection.close()


if __name__ == "__main__":
    unittest.main()
