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


class Service:
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
            raise RuntimeError(f"server failed: {line!r} {stderr}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body).encode()
        request_headers = dict(headers or {})
        if encoded is not None:
            request_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, dict(response.getheaders()), json.loads(payload) if payload else None)
        connection.close()
        return result

    def stop(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "store.json"
        self.service = Service(self.data)

    def tearDown(self):
        self.service.stop()
        self.temp.cleanup()

    def test_crud_keys_and_validation(self):
        self.assertEqual(self.service.request("GET", "/health")[2], {"status": "ok"})
        key = quote("hello world", safe="")
        status, headers, payload = self.service.request("PUT", f"/v1/kv/{key}", {"value": {"x": 1}})
        self.assertEqual(status, 201)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(payload["value"], {"x": 1})
        self.assertEqual(self.service.request("PUT", f"/v1/kv/{key}", {"value": None})[0], 200)
        self.assertEqual(self.service.request("GET", f"/v1/kv/{key}")[2], {"key": "hello world", "value": None})
        self.service.request("PUT", "/v1/kv/a", {"value": 1})
        self.assertEqual(self.service.request("GET", "/v1/keys")[2], {"keys": ["a", "hello world"]})
        self.assertEqual(self.service.request("DELETE", f"/v1/kv/{key}")[0], 204)
        self.assertEqual(self.service.request("DELETE", f"/v1/kv/{key}")[0], 404)
        for path in ("/v1/kv/", "/v1/kv/a%2Fb", "/v1/kv/%FF", "/v1/kv/%Q1"):
            self.assertEqual(self.service.request("GET", path)[0], 400)
        for body in ({}, {"value": 1, "extra": 2}, {"value": 1, "ttl_seconds": 0}, {"value": 1, "ttl_seconds": True}):
            self.assertEqual(self.service.request("PUT", "/v1/kv/x", body)[0], 400)
        self.assertEqual(self.service.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.service.request("GET", "/missing")[0], 404)

    def test_ttl_and_restart_persistence(self):
        self.assertEqual(self.service.request("PUT", "/v1/kv/lasting", {"value": [1, 2]})[0], 201)
        self.assertEqual(self.service.request("PUT", "/v1/kv/brief", {"value": "gone", "ttl_seconds": 0.12})[0], 201)
        time.sleep(0.18)
        self.assertEqual(self.service.request("GET", "/v1/kv/brief")[0], 404)
        self.service.stop()
        self.service = Service(self.data)
        self.assertEqual(self.service.request("GET", "/v1/kv/lasting")[2]["value"], [1, 2])
        self.assertEqual(self.service.request("GET", "/v1/kv/brief")[0], 404)

    def test_concurrent_writes_and_body_limit(self):
        statuses = []
        lock = threading.Lock()

        def write(number):
            status = self.service.request("PUT", f"/v1/kv/k{number:02d}", {"value": number})[0]
            with lock:
                statuses.append(status)

        threads = [threading.Thread(target=write, args=(number,)) for number in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 20)
        self.assertEqual(len(self.service.request("GET", "/v1/keys")[2]["keys"]), 20)

        connection = http.client.HTTPConnection("127.0.0.1", self.service.port, timeout=3)
        connection.request("PUT", "/v1/kv/large", body=b"x", headers={"Content-Length": str(1024 * 1024 + 1)})
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        self.assertEqual(json.loads(response.read())["error"], "request body exceeds 1 MiB")
        connection.close()


if __name__ == "__main__":
    unittest.main()
