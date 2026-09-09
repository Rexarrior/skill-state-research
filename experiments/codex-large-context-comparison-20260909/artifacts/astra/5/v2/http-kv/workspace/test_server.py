import concurrent.futures
import http.client
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import quote


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.data = Path(self.temp.name) / "data.json"
        self.start()

    def start(self):
        self.proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name("server.py")),
                                      "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = self.proc.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING [0-9]+$")
        self.port = int(line.split()[1])

    def stop(self):
        self.proc.terminate()
        stdout, stderr = self.proc.communicate(timeout=10)
        self.assertEqual(self.proc.returncode, 0, stderr)
        self.assertEqual(stdout, "")

    def tearDown(self):
        if self.proc.poll() is None:
            self.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request(method, path, body=raw if raw is not None else (json.dumps(body) if body is not None else None), headers=headers or {})
            response = connection.getresponse()
            payload = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(payload) if payload else None
        finally:
            connection.close()

    def test_crud_restart_and_unicode(self):
        path = "/v1/kv/" + quote("snow ☃ + space", safe="")
        value = {"nested": [None, True, 1, "é"]}
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        self.assertEqual(self.request("PUT", path, {"value": value})[0], 201)
        self.assertEqual(self.request("PUT", path, {"value": value})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path), (200, {"key": "snow ☃ + space", "value": value}))
        self.assertEqual(self.request("DELETE", path), (204, None))
        self.assertEqual(self.request("DELETE", path)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_ttl(self):
        self.request("PUT", "/v1/kv/expires", {"value": 1, "ttl_seconds": 0.3})
        self.request("PUT", "/v1/kv/reset", {"value": 1, "ttl_seconds": 0.3})
        self.request("PUT", "/v1/kv/reset", {"value": 2})
        self.stop()
        time.sleep(0.35)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/expires")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["reset"]}))
        self.assertEqual(self.request("PUT", "/v1/kv/expires", {"value": 3, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.08)
        self.assertEqual(self.request("DELETE", "/v1/kv/expires")[0], 404)

    def test_validation_and_limit(self):
        for raw in ['{', '[]', '{}', '{"value":NaN}', '{"value":1e999}', '{"value":1,"extra":2}']:
            self.assertEqual(self.request("PUT", "/v1/kv/a", raw=raw)[0], 400)
        for ttl in [None, True, 0, -1, "1", [], float("inf")]:
            self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": ttl})[0], 400)
        for key in ["", "%2F", "a/b", "%FF", "%", "%GG"]:
            self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)
        self.assertEqual(self.request("POST", "/health")[0], 405)
        self.assertEqual(self.request("WIBBLE", "/v1/kv/a")[0], 405)
        self.assertEqual(self.request("GET", "/unknown")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/a", raw=b'\xff')[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/a", raw='x' * (1024 * 1024 + 1))[0], 413)
        raw = '{"value":"' + 'x' * (1024 * 1024 - 12) + '"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request("PUT", "/v1/kv/limit", raw=raw)[0], 201)

    def test_concurrent_mutations(self):
        def put(index):
            return self.request("PUT", f"/v1/kv/key{index:03}", {"value": index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(40))), [201] * 40)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(lambda i: self.request("PUT", "/v1/kv/shared", {"value": i})[0], range(16)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 15)
        self.stop()
        self.start()
        expected = [f"key{i:03}" for i in range(40)] + ["shared"]
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": expected}))
        for i in range(40):
            self.assertEqual(self.request("GET", f"/v1/kv/key{i:03}")[1]["value"], i)


if __name__ == "__main__":
    unittest.main()
