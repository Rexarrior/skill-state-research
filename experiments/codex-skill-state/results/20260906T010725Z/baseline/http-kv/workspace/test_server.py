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


class RunningServer:
    def __init__(self, data: Path):
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "server.py"),
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--data",
                str(data),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            raise RuntimeError(f"server failed to start: {line!r}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = (
            None
            if body is None
            else body
            if isinstance(body, bytes)
            else json.dumps(body).encode()
        )
        request_headers = dict(headers or {})
        if encoded is not None:
            request_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, dict(response.getheaders()), raw)
        connection.close()
        return result

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "store.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.stop()
        self.temp.cleanup()

    def json_request(self, method, path, body=None):
        status, headers, raw = self.server.request(method, path, body)
        parsed = None if not raw else json.loads(raw)
        return status, headers, parsed

    def test_crud_unicode_sorting_and_restart(self):
        key = "space ключ"
        path = "/v1/kv/" + quote(key)
        status, _, body = self.json_request("PUT", path, {"value": [1, None]})
        self.assertEqual((status, body), (201, {"key": key, "value": [1, None]}))
        self.assertEqual(self.json_request("PUT", path, {"value": 2})[0], 200)
        self.assertEqual(self.json_request("PUT", "/v1/kv/a", {"value": 1})[0], 201)
        self.assertEqual(self.json_request("GET", "/v1/keys")[2], {"keys": ["a", key]})
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.json_request("GET", path)[2], {"key": key, "value": 2})
        status, headers, body = self.json_request("DELETE", path)
        self.assertEqual(status, 204)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertIsNone(body)
        self.assertEqual(self.json_request("GET", path)[0], 404)

    def test_ttl_and_validation(self):
        self.assertEqual(
            self.json_request("PUT", "/v1/kv/soon", {"value": 1, "ttl_seconds": 0.08})[0],
            201,
        )
        time.sleep(0.12)
        self.assertEqual(self.json_request("GET", "/v1/kv/soon")[0], 404)
        self.assertEqual(self.json_request("GET", "/v1/keys")[2], {"keys": []})
        for ttl in (0, -1, True, None):
            self.assertEqual(
                self.json_request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": ttl})[0],
                400,
            )
        self.assertEqual(self.json_request("GET", "/v1/kv/a%2Fb")[0], 400)
        self.assertEqual(self.json_request("GET", "/missing")[0], 404)
        self.assertEqual(self.json_request("POST", "/health")[0], 405)
        status, headers, body = self.json_request("FROB", "/health")
        self.assertEqual(status, 405)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertIn("error", body)
        self.assertEqual(self.json_request("FROB", "/missing")[0], 404)

    def test_concurrent_writes(self):
        statuses = []
        lock = threading.Lock()

        def write(index):
            status = self.json_request("PUT", f"/v1/kv/k{index}", {"value": index})[0]
            with lock:
                statuses.append(status)

        threads = [threading.Thread(target=write, args=(index,)) for index in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 20)
        self.assertEqual(len(self.json_request("GET", "/v1/keys")[2]["keys"]), 20)

    def test_body_limit(self):
        status, _, body = self.server.request(
            "PUT",
            "/v1/kv/large",
            b"",
            {"Content-Length": str(1024 * 1024 + 1)},
        )
        self.assertEqual(status, 413)
        self.assertIn(b"error", body)


if __name__ == "__main__":
    unittest.main()
