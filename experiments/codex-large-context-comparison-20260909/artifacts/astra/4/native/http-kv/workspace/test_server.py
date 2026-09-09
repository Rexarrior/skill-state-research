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


ROOT = Path(__file__).resolve().parent


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=ROOT)
        self.data = Path(self.directory.name) / "data.json"
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1",
             "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING [0-9]+$")
        self.port = int(line.split()[1])

    def stop(self):
        self.process.terminate()
        try:
            self.assertEqual(self.process.wait(timeout=15), 0)
            self.assertEqual(self.process.stdout.read(), "")
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.process.stdout.close()

    def tearDown(self):
        try:
            self.stop()
        finally:
            self.directory.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            if body is not None:
                raw = json.dumps(body).encode()
            try:
                connection.request(method, path, body=raw, headers=headers or {})
            except BrokenPipeError:
                # The server may reject oversized input before it finishes sending.
                pass
            response = connection.getresponse()
            content = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(content) if content else None
        finally:
            connection.close()

    def test_crud_and_restart(self):
        path = "/v1/kv/" + quote("café key", safe="")
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        self.assertEqual(self.request("PUT", path, {"value": [1, None, {"x": True}]})[0], 201)
        self.assertEqual(self.request("PUT", path, {"value": "updated"})[0], 200)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path), (200, {"key": "café key", "value": "updated"}))
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["café key"]}))
        self.assertEqual(self.request("DELETE", path), (204, None))
        self.assertEqual(self.request("DELETE", path)[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_expiration(self):
        self.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.2})
        self.request("PUT", "/v1/kv/replace", {"value": 1, "ttl_seconds": 0.2})
        self.request("PUT", "/v1/kv/replace", {"value": 2})
        self.stop()
        time.sleep(0.25)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["replace"]})
        self.assertEqual(self.request("PUT", "/v1/kv/short", {"value": 3})[0], 201)
        self.request("PUT", "/v1/kv/delete", {"value": 1, "ttl_seconds": 0.02})
        time.sleep(0.04)
        self.assertEqual(self.request("DELETE", "/v1/kv/delete")[0], 404)

    def test_invalid_requests(self):
        for raw in [b"{", b"[]", b"null", b"{}", b'\xff',
                    b'{"value":NaN}', b'{"value":1e999}']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request("PUT", "/v1/kv/key", raw=raw)[0], 400)
        for ttl in [0, -1, True, "1", None, [], float("inf"), 10 ** 400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request("PUT", "/v1/kv/key", {"value": 1, "ttl_seconds": ttl})[0], 400)
        for key in ["", "a/b", "a%2Fb", "%FF", "%", "%GG", "%ED%A0%80"]:
            with self.subTest(key=key):
                self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)
        self.assertEqual(self.request("POST", "/v1/kv/key")[0], 405)
        self.assertEqual(self.request("BREW", "/health")[0], 405)
        self.assertEqual(self.request("PUT", "/health", {"value": 1})[0], 405)
        self.assertEqual(self.request("GET", "/unknown")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/key", raw=b"x" * (1024 * 1024 + 1))[0], 413)
        self.assertEqual(self.request("PUT", "/v1/kv/key", raw=b"{}", headers={"Content-Length": "-1"})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/key", raw=b"{}", headers={"Transfer-Encoding": "chunked"})[0], 400)

    def test_concurrent_writes(self):
        def put(index):
            return self.request("PUT", f"/v1/kv/{index:03}", {"value": index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(60))), [201] * 60)
        expected = {"keys": [f"{index:03}" for index in range(60)]}
        self.assertEqual(self.request("GET", "/v1/keys")[1], expected)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/keys")[1], expected)
        for index in range(60):
            self.assertEqual(self.request("GET", f"/v1/kv/{index:03}")[1]["value"], index)


if __name__ == "__main__":
    unittest.main()
