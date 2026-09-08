"""End-to-end tests; run with python3 -m unittest -v."""

from concurrent.futures import ThreadPoolExecutor
import http.client
import json
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / "data.json"
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1",
             "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            cwd=ROOT)
        self.assertTrue(select.select([self.process.stdout], [], [], 5)[0],
                        "server did not announce its port")
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING [0-9]+$")
        self.port = int(line.split()[1])
        self.assertGreater(self.port, 0)

    def stop(self):
        if self.process is not None:
            process, self.process = self.process, None
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                self.fail("SIGTERM did not stop server")
            extra = process.stdout.read()
            process.stdout.close()
            self.assertEqual(process.returncode, 0)
            self.assertEqual(extra, "", "diagnostics leaked to stdout")

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=8)
        try:
            payload = raw if raw is not None else (
                json.dumps(body).encode() if body is not None else None)
            connection.request(method, path, body=payload, headers=headers or {})
            response = connection.getresponse()
            content = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(content) if content else None
        finally:
            connection.close()

    def test_crud_and_routes(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        path = "/v1/kv/" + quote("hello café", safe="")
        value = {"nested": [None, True, 4.5, {"x": "世界"}]}
        self.assertEqual(self.request("PUT", path, {"value": value})[0], 201)
        self.assertEqual(self.request("GET", path),
                         (200, {"key": "hello café", "value": value}))
        self.assertEqual(self.request("PUT", path, {"value": False})[0], 200)
        self.assertEqual(self.request("GET", path)[1]["value"], False)
        self.assertEqual(self.request("DELETE", path), (204, None))
        self.assertEqual(self.request("DELETE", path)[0], 404)
        self.assertEqual(self.request("GET", path)[0], 404)
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        for method in ("POST", "PATCH", "OPTIONS", "BREW"):
            self.assertEqual(self.request(method, "/v1/kv/x")[0], 405)
        self.assertEqual(self.request("PUT", "/health", {"value": 1})[0], 405)

    def test_validation(self):
        for raw in (b"", b"{", b"[]", b"null", b"1", b"{}", b'"text"',
                    b'{"value":NaN}', b'{"value":Infinity}', b'{"value":1e999}',
                    b'{"value":"\xff"}', b'{"value":0,"unexpected":1}'):
            with self.subTest(raw=raw):
                self.assertEqual(self.request("PUT", "/v1/kv/x", raw=raw)[0], 400)
        for ttl in (0, -1, True, None, "1", [], {}, float("inf"), float("nan")):
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request("PUT", "/v1/kv/x",
                                              {"value": 1, "ttl_seconds": ttl})[0], 400)
        for key in ("", "a/b", "a%2Fb", "%ff", "%", "%GG", "%ED%A0%80"):
            with self.subTest(key=key):
                self.assertEqual(self.request("PUT", "/v1/kv/" + key,
                                              {"value": 1})[0], 400)

    def test_body_limit(self):
        # Exactly 1 MiB is accepted, including JSON syntax.
        raw = b'{"value":"' + b'a' * (1024 * 1024 - 12) + b'"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request("PUT", "/v1/kv/limit", raw=raw)[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/too-big", raw=b"",
                                      headers={"Content-Length": str(1024 * 1024 + 1)})[0], 413)
        self.assertEqual(self.request("PUT", "/v1/kv/x", raw=b"",
                                      headers={"Content-Length": "-1"})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/x", raw=b"",
                                      headers={"Transfer-Encoding": "chunked"})[0], 400)

    def test_persistence_and_expiration(self):
        self.request("PUT", "/v1/kv/permanent", {"value": [1, 2]})
        self.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.3})
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 200)
        self.stop()
        time.sleep(0.35)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/permanent")[1]["value"], [1, 2])
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)
        self.assertNotIn("short", json.loads(self.data.read_text())["entries"])
        self.assertEqual(self.request("PUT", "/v1/kv/short", {"value": 2})[0], 201)
        self.request("DELETE", "/v1/kv/permanent")
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["short"]}))

    def test_live_expiration_and_ttl_removal(self):
        for key in ("get", "delete", "replace", "list", "keep"):
            self.request("PUT", "/v1/kv/" + key, {"value": 1, "ttl_seconds": 0.2})
        self.request("PUT", "/v1/kv/keep", {"value": 2})
        time.sleep(0.25)
        self.assertEqual(self.request("GET", "/v1/kv/get")[0], 404)
        self.assertEqual(self.request("DELETE", "/v1/kv/delete")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/replace", {"value": 3})[0], 201)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["keep", "replace"]})

    def test_concurrent_writes(self):
        def put(index):
            return self.request("PUT", f"/v1/kv/key-{index:03}", {"value": index})[0]
        with ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(60))), [201] * 60)
        expected = [f"key-{index:03}" for index in range(60)]
        self.assertEqual(self.request("GET", "/v1/keys")[1]["keys"], expected)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/keys")[1]["keys"], expected)
        for index in range(60):
            self.assertEqual(self.request("GET", f"/v1/kv/key-{index:03}")[1]["value"], index)


if __name__ == "__main__":
    unittest.main()
