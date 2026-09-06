import http.client
import json
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
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
        line = self.process.stdout.readline()
        if not line.startswith("LISTENING "):
            raise RuntimeError(f"server failed to start: {line!r} {self.process.stderr.read()}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = body if isinstance(body, bytes) else (None if body is None else json.dumps(body).encode())
        connection.request(method, path, body=encoded, headers=headers or {})
        response = connection.getresponse()
        content = response.read()
        result = (response.status, response.getheader("Content-Type"), content)
        connection.close()
        return result

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        if self.process.stdout is not None:
            self.process.stdout.close()
        if self.process.stderr is not None:
            self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "state.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.stop()
        self.temp.cleanup()

    def json_request(self, *args, **kwargs):
        status, content_type, body = self.server.request(*args, **kwargs)
        self.assertEqual(content_type, "application/json")
        return status, json.loads(body) if body else None

    def test_crud_keys_and_restart(self):
        key = quote("hello world")
        self.assertEqual(self.json_request("PUT", f"/v1/kv/{key}", {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.json_request("PUT", f"/v1/kv/{key}", {"value": [2]})[0], 200)
        self.assertEqual(self.json_request("GET", f"/v1/kv/{key}"), (200, {"key": "hello world", "value": [2]}))
        self.assertEqual(self.json_request("GET", "/v1/keys"), (200, {"keys": ["hello world"]}))
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.json_request("GET", f"/v1/kv/{key}")[0], 200)
        self.assertEqual(self.json_request("DELETE", f"/v1/kv/{key}")[0], 204)
        self.assertEqual(self.json_request("GET", f"/v1/kv/{key}")[0], 404)

    def test_ttl_validation_and_errors(self):
        self.assertEqual(self.json_request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.08)
        self.assertEqual(self.json_request("GET", "/v1/kv/short")[0], 404)
        self.assertEqual(self.json_request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": True})[0], 400)
        self.assertEqual(self.json_request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": None})[0], 400)
        self.assertEqual(self.json_request("GET", "/v1/kv/a%2Fb")[0], 400)
        self.assertEqual(self.json_request("POST", "/health", {})[0], 405)
        self.assertEqual(self.json_request("GET", "/unknown")[0], 404)

    def test_health_invalid_json_and_limit(self):
        self.assertEqual(self.json_request("GET", "/health"), (200, {"status": "ok"}))
        status, kind, body = self.server.request(
            "PUT", "/v1/kv/x", b"not-json", {"Content-Length": "8"}
        )
        self.assertEqual((status, kind), (400, "application/json"))
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request("PUT", "/v1/kv/x", body=b"", headers={"Content-Length": str(1024 * 1024 + 1)})
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        connection.close()

    def test_concurrent_writes_and_expiration_across_restart(self):
        def put(number):
            return self.json_request("PUT", f"/v1/kv/k{number:02d}", {"value": number})[0]

        with ThreadPoolExecutor(max_workers=8) as workers:
            self.assertEqual(list(workers.map(put, range(20))), [201] * 20)
        self.assertEqual(
            self.json_request("GET", "/v1/keys"),
            (200, {"keys": [f"k{number:02d}" for number in range(20)]}),
        )

        self.assertEqual(
            self.json_request("PUT", "/v1/kv/temporary", {"value": True, "ttl_seconds": 0.05})[0],
            201,
        )
        self.server.stop()
        time.sleep(0.08)
        self.server = RunningServer(self.data)
        self.assertEqual(self.json_request("GET", "/v1/kv/temporary")[0], 404)
        self.assertNotIn("temporary", json.loads(self.data.read_text())["entries"])


if __name__ == "__main__":
    unittest.main()
