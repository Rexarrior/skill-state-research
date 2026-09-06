import http.client
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.temp.name, "store.json")
        self.start()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def start(self):
        self.proc = subprocess.Popen([sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", self.data], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = self.proc.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING \d+$")
        self.port = int(line.split()[1])

    def stop(self):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            self.proc.wait(timeout=5)

    def request(self, method, path, payload=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        body = None if payload is None else json.dumps(payload)
        conn.request(method, path, body, {"Content-Type": "application/json"} if body else {})
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        return response.status, json.loads(raw) if raw else None

    def test_crud_persistence_and_unicode(self):
        self.assertEqual(self.request("PUT", "/v1/kv/hello%20%C3%A9", {"value": {"x": 1}})[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/hello%20%C3%A9", {"value": 2})[0], 200)
        self.assertEqual(self.request("GET", "/v1/kv/hello%20%C3%A9"), (200, {"key": "hello é", "value": 2}))
        self.stop(); self.start()
        self.assertEqual(self.request("GET", "/v1/kv/hello%20%C3%A9")[1]["value"], 2)
        self.assertEqual(self.request("DELETE", "/v1/kv/hello%20%C3%A9")[0], 204)
        self.assertEqual(self.request("GET", "/v1/kv/hello%20%C3%A9")[0], 404)

    def test_ttl_keys_and_errors(self):
        self.request("PUT", "/v1/kv/z", {"value": 1})
        self.request("PUT", "/v1/kv/a", {"value": 2, "ttl_seconds": 0.05})
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["a", "z"]})
        time.sleep(0.08)
        self.assertEqual(self.request("GET", "/v1/kv/a")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["z"]})
        self.assertEqual(self.request("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0})[0], 400)
        self.assertEqual(self.request("POST", "/health")[0], 405)


if __name__ == "__main__":
    unittest.main()
