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


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "data.json"
        self.start()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline()
        self.assertRegex(line, r"^LISTENING \d+\n$")
        self.port = int(line.split()[1])

    def stop(self):
        if getattr(self, "process", None) and self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=3)
        if getattr(self, "process", None):
            self.assertEqual(self.process.returncode, 0, self.process.stderr.read())

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        content_type = response.getheader("Content-Type")
        connection.close()
        return response.status, content_type, json.loads(raw) if raw else None

    def test_crud_encoding_sorting_and_restart(self):
        self.assertEqual(self.request("GET", "/health"), (200, "application/json", {"status": "ok"}))
        for key, value in [("z", [1, True]), ("hello world", {"x": None}), ("é", "yes")]:
            status, _, payload = self.request("PUT", "/v1/kv/" + quote(key), {"value": value})
            self.assertEqual(status, 201)
            self.assertEqual(payload, {"key": key, "value": value})
        self.assertEqual(self.request("PUT", "/v1/kv/z", {"value": 2})[0], 200)
        self.assertEqual(self.request("GET", "/v1/keys")[2], {"keys": ["hello world", "z", "é"]})
        self.assertEqual(self.request("DELETE", "/v1/kv/hello%20world"), (204, None, None))
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/z")[2], {"key": "z", "value": 2})
        self.assertEqual(self.request("GET", "/v1/kv/hello%20world")[0], 404)

    def test_ttl_and_validation(self):
        self.assertEqual(self.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": .08})[0], 201)
        time.sleep(.12)
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)
        for ttl in [0, -1, True, "2"]:
            self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": ttl})[0], 400)
        for path in ["/v1/kv/", "/v1/kv/a%2Fb", "/v1/kv/%FF", "/v1/kv/%GG"]:
            self.assertEqual(self.request("GET", path)[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/a", "no", {"Content-Length": "2"})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/a", {})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "extra": 2})[0], 400)
        self.assertEqual(self.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.request("GET", "/missing")[0], 404)

    def test_body_limit_and_concurrency(self):
        oversized = json.dumps({"value": "x" * 1024 * 1024})
        self.assertEqual(self.request("PUT", "/v1/kv/large", oversized)[0], 413)
        errors = []
        def write(index):
            try:
                status = self.request("PUT", f"/v1/kv/k{index}", {"value": index})[0]
                if status != 201:
                    errors.append(status)
            except Exception as exc:
                errors.append(exc)
        threads = [threading.Thread(target=write, args=(i,)) for i in range(20)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(self.request("GET", "/v1/keys")[2]["keys"]), 20)
        with self.data.open(encoding="utf-8") as stream:
            self.assertEqual(len(json.load(stream)["entries"]), 20)


if __name__ == "__main__":
    unittest.main()
