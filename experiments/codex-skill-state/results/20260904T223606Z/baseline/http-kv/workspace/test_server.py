import http.client
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).parent


class Service:
    def __init__(self, data):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data)],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        line = self.process.stdout.readline().strip()
        self.port = int(line.removeprefix("LISTENING "))

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        headers = {} if body is None else {"Content-Type": "application/json"}
        connection.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
        response = connection.getresponse()
        content = response.read()
        connection.close()
        return response.status, json.loads(content) if content else None

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=3)
        self.process.stdout.close()
        self.process.stderr.close()


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "state.json"
        self.service = Service(self.data)

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def test_crud_url_encoding_and_sorting(self):
        key = quote("a space", safe="")
        self.assertEqual(self.service.request("PUT", f"/v1/kv/{key}", {"value": [1, True]})[0], 201)
        self.assertEqual(self.service.request("PUT", "/v1/kv/z", {"value": None})[0], 201)
        self.assertEqual(self.service.request("GET", f"/v1/kv/{key}"), (200, {"key": "a space", "value": [1, True]}))
        self.assertEqual(self.service.request("GET", "/v1/keys"), (200, {"keys": ["a space", "z"]}))
        self.assertEqual(self.service.request("DELETE", f"/v1/kv/{key}")[0], 204)
        self.assertEqual(self.service.request("GET", f"/v1/kv/{key}")[0], 404)

    def test_ttl_validation_expiry_and_restart(self):
        self.assertEqual(self.service.request("PUT", "/v1/kv/tmp", {"value": 9, "ttl_seconds": 0})[0], 400)
        self.assertEqual(self.service.request("PUT", "/v1/kv/tmp", {"value": 9, "ttl_seconds": .05})[0], 201)
        time.sleep(.1)
        self.assertEqual(self.service.request("GET", "/v1/kv/tmp")[0], 404)
        self.assertEqual(self.service.request("PUT", "/v1/kv/kept", {"value": {"x": 1}})[0], 201)
        self.service.close()
        self.service = Service(self.data)
        self.assertEqual(self.service.request("GET", "/v1/kv/kept"), (200, {"key": "kept", "value": {"x": 1}}))

    def test_errors_and_body_limit(self):
        self.assertEqual(self.service.request("GET", "/v1/kv/")[0], 400)
        self.assertEqual(self.service.request("POST", "/health")[0], 405)
        connection = http.client.HTTPConnection("127.0.0.1", self.service.port, timeout=3)
        connection.putrequest("PUT", "/v1/kv/big")
        connection.putheader("Content-Length", str(1024 * 1024 + 1))
        connection.endheaders()
        self.assertEqual(connection.getresponse().status, 413)
        connection.close()


if __name__ == "__main__":
    unittest.main()
