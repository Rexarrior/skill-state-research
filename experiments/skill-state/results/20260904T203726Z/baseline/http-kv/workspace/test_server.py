import http.client
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import quote


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.data = Path(self.tempdir.name) / "state.json"
        self.start()

    def tearDown(self):
        self.stop()
        self.tempdir.cleanup()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING [1-9][0-9]*$")
        self.port = int(line.split()[1])

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Content-Type": "application/json"} if body is not None else {}
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        raw = response.read()
        payload = json.loads(raw) if raw else None
        connection.close()
        return response.status, dict(response.getheaders()), payload

    def test_crud_encoding_and_persistence(self):
        key = "space key"
        path = "/v1/kv/" + quote(key)
        status, headers, payload = self.request("PUT", path, {"value": [1, {"ok": True}]})
        self.assertEqual((status, payload), (201, {"key": key, "value": [1, {"ok": True}]}))
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(self.request("PUT", path, {"value": "replaced"})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path)[2], {"key": key, "value": "replaced"})
        self.assertEqual(self.request("GET", "/v1/keys")[2], {"keys": [key]})
        self.assertEqual(self.request("DELETE", path)[0], 204)
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_ttl_and_invalid_requests(self):
        self.assertEqual(self.request("PUT", "/v1/kv/temporary", {"value": 1, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.1)
        self.assertEqual(self.request("GET", "/v1/kv/temporary")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": 0})[0], 400)
        self.assertEqual(self.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("GET", "/health")[2], {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
