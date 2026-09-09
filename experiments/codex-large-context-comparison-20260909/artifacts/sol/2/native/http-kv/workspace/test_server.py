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


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "state.json"
        self.start()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def start(self):
        self.proc = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.proc.stdout.readline()
        self.assertRegex(line, r"^LISTENING \d+\n$")
        self.port = int(line.split()[1])

    def stop(self):
        if getattr(self, "proc", None) and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            self.proc.wait(timeout=5)
        if getattr(self, "proc", None):
            self.proc.stdout.close()
            self.proc.stderr.close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body).encode()
        request_headers = {} if headers is None else dict(headers)
        if encoded is not None:
            request_headers.setdefault("Content-Type", "application/json")
            request_headers.setdefault("Content-Length", str(len(encoded)))
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, response.getheader("Content-Type"), raw)
        connection.close()
        return result

    def test_crud_keys_and_restart(self):
        status, content_type, _ = self.request("PUT", "/v1/kv/hello%20world", {"value": {"x": 1}})
        self.assertEqual((status, content_type), (201, "application/json"))
        self.assertEqual(self.request("PUT", "/v1/kv/hello%20world", {"value": False})[0], 200)
        status, _, raw = self.request("GET", "/v1/kv/hello%20world")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), {"key": "hello world", "value": False})
        self.assertEqual(json.loads(self.request("GET", "/v1/keys")[2]), {"keys": ["hello world"]})
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/hello%20world")[0], 200)
        status, content_type, raw = self.request("DELETE", "/v1/kv/hello%20world")
        self.assertEqual((status, content_type, raw), (204, "application/json", b""))
        self.assertEqual(self.request("GET", "/v1/kv/hello%20world")[0], 404)

    def test_ttl_and_errors(self):
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": 0.08})[0], 201)
        time.sleep(0.12)
        self.assertEqual(self.request("GET", "/v1/kv/a")[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/a")[0], 404)
        for path in ("/v1/kv/", "/v1/kv/a%2Fb", "/v1/kv/%ZZ", "/v1/kv/%FF"):
            self.assertEqual(self.request("GET", path)[0], 400)
        for ttl in (0, -1, True, float("inf")):
            self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.request("GET", "/missing")[0], 404)

    def test_concurrent_writes(self):
        statuses = []

        def write(index):
            statuses.append(self.request("PUT", f"/v1/kv/k{index:02}", {"value": index})[0])

        threads = [threading.Thread(target=write, args=(index,)) for index in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 20)
        keys = json.loads(self.request("GET", "/v1/keys")[2])["keys"]
        self.assertEqual(keys, [f"k{index:02}" for index in range(20)])
        with self.data.open(encoding="utf-8") as handle:
            self.assertEqual(len(json.load(handle)["entries"]), 20)

    def test_health_and_body_limit(self):
        self.assertEqual(json.loads(self.request("GET", "/health")[2]), {"status": "ok"})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("PUT", "/v1/kv/a", body=b"{}", headers={"Content-Length": str(1024 * 1024 + 1)})
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        connection.close()


if __name__ == "__main__":
    unittest.main()
