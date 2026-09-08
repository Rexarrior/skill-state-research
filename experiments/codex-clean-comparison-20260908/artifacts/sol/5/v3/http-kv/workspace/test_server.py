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
from urllib.parse import quote


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.temp.name, "nested", "data.json")
        self.start()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", self.data],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING [0-9]+$")
        self.port = int(line.split()[1])

    def stop(self):
        if getattr(self, "process", None) and self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        if getattr(self, "process", None):
            self.process.stdout.close()
            self.process.stderr.close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body).encode()
        connection.request(method, path, encoded, headers or {})
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, dict(response.getheaders()), json.loads(raw) if raw else None)
        connection.close()
        return result

    def test_crud_keys_and_restart(self):
        key = "snow ☃ space"
        path = "/v1/kv/" + quote(key, safe="")
        status, headers, body = self.request("PUT", path, {"value": {"x": [1, True, None]}})
        self.assertEqual(status, 201)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(self.request("PUT", path, {"value": "new"})[0], 200)
        self.assertEqual(self.request("GET", path)[2], {"key": key, "value": "new"})
        self.assertEqual(self.request("GET", "/v1/keys")[2], {"keys": [key]})
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path)[2], {"key": key, "value": "new"})
        self.assertEqual(self.request("DELETE", path)[0], 204)
        self.assertEqual(self.request("DELETE", path)[0], 404)

    def test_ttl_validation_errors_and_health(self):
        self.assertEqual(self.request("GET", "/health")[2], {"status": "ok"})
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": 0})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"ttl_seconds": 1})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/%2F", {"value": 1})[0], 400)
        self.assertEqual(self.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": .08})[0], 201)
        time.sleep(.12)
        self.assertEqual(self.request("GET", "/v1/kv/a")[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/keys")[2], {"keys": []})

    def test_malformed_and_limit(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("PUT", "/v1/kv/a", b"{bad", {"Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        response.read()
        connection.close()
        huge = {"value": "x" * (1024 * 1024)}
        self.assertEqual(self.request("PUT", "/v1/kv/a", huge)[0], 413)

    def test_concurrent_writes_remain_valid(self):
        statuses = []
        def write(number):
            statuses.append(self.request("PUT", f"/v1/kv/k{number}", {"value": number})[0])
        threads = [threading.Thread(target=write, args=(number,)) for number in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 12)
        with open(self.data, encoding="utf-8") as source:
            persisted = json.load(source)
        self.assertEqual(len(persisted["entries"]), 12)


if __name__ == "__main__":
    unittest.main()
