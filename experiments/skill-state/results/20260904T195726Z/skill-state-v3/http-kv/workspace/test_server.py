import http.client
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).parent


class Service:
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
            raise RuntimeError(f"server failed: {line!r} {self.process.stderr.read()}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = body if isinstance(body, bytes) else None if body is None else json.dumps(body).encode()
        connection.request(method, path, body=encoded, headers=headers or {})
        response = connection.getresponse()
        content = response.read()
        result = (response.status, dict(response.headers), json.loads(content) if content else None)
        connection.close()
        return result

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=3)
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

    def test_crud_keys_and_restart(self):
        key = quote("hello world")
        self.assertEqual(self.service.request("PUT", f"/v1/kv/{key}", {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.service.request("PUT", "/v1/kv/z", {"value": None})[0], 201)
        self.assertEqual(self.service.request("PUT", f"/v1/kv/{key}", {"value": [2]})[0], 200)
        self.assertEqual(self.service.request("GET", f"/v1/kv/{key}")[2], {"key": "hello world", "value": [2]})
        self.assertEqual(self.service.request("GET", "/v1/keys")[2], {"keys": ["hello world", "z"]})
        self.service.stop()
        self.service = Service(self.data)
        self.assertEqual(self.service.request("GET", f"/v1/kv/{key}")[2]["value"], [2])
        self.assertEqual(self.service.request("DELETE", f"/v1/kv/{key}")[0], 204)
        self.assertEqual(self.service.request("DELETE", f"/v1/kv/{key}")[0], 404)

    def test_ttl_validation_errors_and_limits(self):
        self.assertEqual(self.service.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0})[0], 400)
        self.assertEqual(self.service.request("PUT", "/v1/kv/x", [1])[0], 400)
        self.assertEqual(self.service.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        self.assertEqual(self.service.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.service.request("GET", "/missing")[0], 404)
        self.assertEqual(self.service.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.08)
        self.assertEqual(self.service.request("GET", "/v1/kv/x")[0], 404)
        status = self.service.request(
            "PUT", "/v1/kv/large", b"", {"Content-Length": str(1024 * 1024 + 1)}
        )[0]
        self.assertEqual(status, 413)

    def test_concurrent_writes(self):
        statuses = []
        lock = threading.Lock()

        def write(number):
            status = self.service.request("PUT", f"/v1/kv/k{number}", {"value": number})[0]
            with lock:
                statuses.append(status)

        threads = [threading.Thread(target=write, args=(number,)) for number in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 12)
        self.assertEqual(len(self.service.request("GET", "/v1/keys")[2]["keys"]), 12)


if __name__ == "__main__":
    unittest.main()
