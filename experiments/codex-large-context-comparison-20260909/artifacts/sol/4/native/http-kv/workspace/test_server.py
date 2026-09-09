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
    def __init__(self, data: Path):
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1", "--port", "0", "--data", str(data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            raise RuntimeError(f"server failed to start: {line}; {self.process.stderr.read()}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None, raw=False):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = body if raw else (None if body is None else json.dumps(body).encode())
        request_headers = dict(headers or {})
        if encoded is not None:
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, response.getheader("Content-Type"), json.loads(raw) if raw else None)
        connection.close()
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "state.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.close()
        self.temp.cleanup()

    def test_crud_unicode_sorting_and_errors(self):
        key = "tea time ☕"
        path = "/v1/kv/" + quote(key, safe="")
        self.assertEqual(self.server.request("PUT", path, {"value": {"hot": True}})[0], 201)
        self.assertEqual(self.server.request("PUT", path, {"value": [1, None]})[0], 200)
        status, content_type, result = self.server.request("GET", path)
        self.assertEqual((status, content_type), (200, "application/json"))
        self.assertEqual(result, {"key": key, "value": [1, None]})
        self.server.request("PUT", "/v1/kv/alpha", {"value": 1})
        self.assertEqual(self.server.request("GET", "/v1/keys")[2]["keys"], ["alpha", key])
        self.assertEqual(self.server.request("DELETE", path)[0], 204)
        self.assertEqual(self.server.request("DELETE", "/v1/kv/alpha")[1], "application/json")
        self.assertEqual(self.server.request("GET", path)[0], 404)
        self.assertEqual(self.server.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.server.request("TRACE", "/health")[0], 405)
        self.assertEqual(self.server.request("GET", "/unknown")[0], 404)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0})[0], 400)

    def test_ttl_and_restart_persistence(self):
        self.server.request("PUT", "/v1/kv/durable", {"value": "yes"})
        self.server.request("PUT", "/v1/kv/brief", {"value": "no", "ttl_seconds": 0.15})
        self.server.close()
        time.sleep(0.2)
        self.server = RunningServer(self.data)
        self.assertEqual(self.server.request("GET", "/v1/kv/durable")[2]["value"], "yes")
        self.assertEqual(self.server.request("GET", "/v1/kv/brief")[0], 404)
        persisted = json.loads(self.data.read_text())
        self.assertNotIn("brief", persisted["entries"])

    def test_body_validation_and_size_limit(self):
        self.assertEqual(self.server.request("PUT", "/v1/kv/x", b"{", raw=True)[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/x", [], raw=False)[0], 400)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.putrequest("PUT", "/v1/kv/x")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(1024 * 1024 + 1))
        connection.endheaders()
        response = connection.getresponse()
        response.read()
        self.assertEqual(response.status, 413)
        connection.close()

    def test_concurrent_writes_remain_valid(self):
        failures = []

        def write(index):
            try:
                status = self.server.request("PUT", f"/v1/kv/k{index}", {"value": index})[0]
                if status != 201:
                    failures.append(status)
            except Exception as exc:  # reported through the assertion below
                failures.append(exc)

        threads = [threading.Thread(target=write, args=(index,)) for index in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(failures, [])
        self.assertEqual(len(self.server.request("GET", "/v1/keys")[2]["keys"]), 20)
        self.assertEqual(len(json.loads(self.data.read_text())["entries"]), 20)


if __name__ == "__main__":
    unittest.main()
