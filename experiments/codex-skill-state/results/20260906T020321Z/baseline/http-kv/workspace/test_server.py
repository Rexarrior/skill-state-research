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


ROOT = Path(__file__).resolve().parent


class RunningServer:
    def __init__(self, data_path: Path):
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
            raise RuntimeError(f"server failed to start: {line!r} {stderr!r}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        payload = None if body is None else json.dumps(body, separators=(",", ":"))
        actual_headers = dict(headers or {})
        if payload is not None:
            actual_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=payload, headers=actual_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, dict(response.getheaders()), json.loads(raw) if raw else None)
        connection.close()
        return result

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
        self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.data = Path(self.tempdir.name) / "nested" / "store.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.stop()
        self.tempdir.cleanup()

    def test_crud_sorting_and_encoded_key(self):
        encoded = quote("hello world", safe="")
        self.assertEqual(self.server.request("PUT", f"/v1/kv/{encoded}", {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.server.request("PUT", f"/v1/kv/{encoded}", {"value": None})[0], 200)
        self.assertEqual(self.server.request("PUT", "/v1/kv/alpha", {"value": True})[0], 201)
        status, headers, body = self.server.request("GET", "/v1/keys")
        self.assertEqual((status, body), (200, {"keys": ["alpha", "hello world"]}))
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(self.server.request("GET", f"/v1/kv/{encoded}")[2], {"key": "hello world", "value": None})
        self.assertEqual(self.server.request("DELETE", f"/v1/kv/{encoded}")[0], 204)
        self.assertEqual(self.server.request("GET", f"/v1/kv/{encoded}")[0], 404)

    def test_ttl_and_restart(self):
        self.assertEqual(self.server.request("PUT", "/v1/kv/short", {"value": 3, "ttl_seconds": 0.15})[0], 201)
        time.sleep(0.25)
        self.assertEqual(self.server.request("GET", "/v1/kv/short")[0], 404)
        self.assertEqual(self.server.request("GET", "/v1/keys")[2], {"keys": []})
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.server.request("GET", "/v1/kv/short")[0], 404)

    def test_persistence_and_errors(self):
        self.server.request("PUT", "/v1/kv/saved", {"value": [1, "two"]})
        self.server.stop()
        self.server = RunningServer(self.data)
        self.assertEqual(self.server.request("GET", "/v1/kv/saved")[2]["value"], [1, "two"])
        for body in (
            {},
            {"value": 1, "extra": 2},
            {"value": 1, "ttl_seconds": 0},
            {"value": 1, "ttl_seconds": True},
            {"value": 1, "ttl_seconds": None},
        ):
            self.assertEqual(self.server.request("PUT", "/v1/kv/bad", body)[0], 400)
        self.assertEqual(self.server.request("GET", "/v1/kv/a%2Fb")[0], 400)
        self.assertEqual(self.server.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.server.request("GET", "/missing")[0], 404)

    def test_concurrent_writes_are_not_lost(self):
        statuses = []

        def put(index):
            statuses.append(self.server.request("PUT", f"/v1/kv/k{index:02}", {"value": index})[0])

        threads = [threading.Thread(target=put, args=(i,)) for i in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 20)
        self.assertEqual(len(self.server.request("GET", "/v1/keys")[2]["keys"]), 20)

    def test_body_limit(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request(
            "PUT",
            "/v1/kv/large",
            body=b"",
            headers={"Content-Type": "application/json", "Content-Length": str(1024 * 1024 + 1)},
        )
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        response.read()
        connection.close()


if __name__ == "__main__":
    unittest.main()
