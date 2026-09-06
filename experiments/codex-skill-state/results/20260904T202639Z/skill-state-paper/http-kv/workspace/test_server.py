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
    def __init__(self, data: Path):
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1", "--port", "0", "--data", str(data)],
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
        encoded = body if isinstance(body, bytes) else None if body is None else json.dumps(body).encode()
        connection.request(method, path, body=encoded, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, response.getheader("Content-Type"), payload)
        connection.close()
        return result

    def stop(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=3)
        self.process.stdout.close()
        self.process.stderr.close()


class ServiceTests(unittest.TestCase):
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

    def test_crud_listing_and_encoded_key(self):
        key_path = quote("hello world", safe="")
        status, content_type, payload = self.json_request("PUT", f"/v1/kv/{key_path}", {"value": {"n": 1}})
        self.assertEqual((status, content_type), (201, "application/json"))
        self.assertEqual(payload["value"], {"n": 1})
        self.assertEqual(self.json_request("PUT", f"/v1/kv/{key_path}", {"value": False})[0], 200)
        self.assertEqual(self.json_request("GET", f"/v1/kv/{key_path}")[2], {"key": "hello world", "value": False})
        self.json_request("PUT", "/v1/kv/alpha", {"value": 2})
        self.assertEqual(self.json_request("GET", "/v1/keys")[2], {"keys": ["alpha", "hello world"]})
        self.assertEqual(self.json_request("DELETE", f"/v1/kv/{key_path}")[0], 204)
        self.assertEqual(self.json_request("GET", f"/v1/kv/{key_path}")[0], 404)

    def test_ttl_and_validation(self):
        self.assertEqual(self.json_request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.1})[0], 201)
        time.sleep(0.15)
        self.assertEqual(self.json_request("GET", "/v1/kv/short")[0], 404)
        for ttl in (0, -1, True, float("inf")):
            self.assertEqual(self.json_request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.json_request("PUT", "/v1/kv/x", [1, 2])[0], 400)
        self.assertEqual(self.json_request("GET", "/v1/kv/%2F")[0], 400)
        self.assertEqual(self.json_request("POST", "/health", {})[0], 405)
        self.assertEqual(self.json_request("GET", "/missing")[0], 404)

    def test_persistence_restart(self):
        self.assertEqual(self.json_request("PUT", "/v1/kv/durable", {"value": [1, None, "x"]})[0], 201)
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.json_request("GET", "/v1/kv/durable")[2]["value"], [1, None, "x"])

    def test_body_limit_and_health(self):
        self.assertEqual(self.json_request("GET", "/health")[2], {"status": "ok"})
        status, content_type, payload = self.server.request(
            "PUT", "/v1/kv/large", b"", {"Content-Length": str(1024 * 1024 + 1)}
        )
        self.assertEqual(status, 413)
        self.assertEqual(content_type, "application/json")
        self.assertTrue(json.loads(payload)["error"])

    def test_concurrent_writes(self):
        statuses = []
        lock = threading.Lock()

        def write(index):
            status = self.json_request("PUT", f"/v1/kv/k{index}", {"value": index})[0]
            with lock:
                statuses.append(status)

        threads = [threading.Thread(target=write, args=(index,)) for index in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 12)
        self.assertEqual(len(self.json_request("GET", "/v1/keys")[2]["keys"]), 12)
        with self.data.open(encoding="utf-8") as handle:
            self.assertEqual(len(json.load(handle)["entries"]), 12)


if __name__ == "__main__":
    unittest.main()
