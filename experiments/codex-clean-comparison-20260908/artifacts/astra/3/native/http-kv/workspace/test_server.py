"""Integration tests using only the Python standard library."""

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


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name) / "state.json"
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("server.py")),
             "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        ready, _, _ = select.select([self.process.stdout], [], [], 5)
        self.assertTrue(ready, "Server did not announce its port")
        line = self.process.stdout.readline()
        self.assertRegex(line, r"^LISTENING [0-9]+\n$")
        self.port = int(line.split()[1])

    def stop(self):
        if self.process is not None:
            process, self.process = self.process, None
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                self.fail("Server did not shut down cleanly")
            finally:
                process.stdout.close()
            self.assertEqual(process.returncode, 0)

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=8)
        try:
            payload = json.dumps(body).encode() if body is not None else raw
            connection.request(method, path, payload, headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def put(self, key, value, **kwargs):
        return self.request("PUT", "/v1/kv/" + quote(key, safe=""), {"value": value, **kwargs})

    def test_crud_and_json_values(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        for value in [None, True, 4, 1.5, "héllo", [1, None], {"nested": [False]}]:
            self.assertEqual(self.put("a key ☃", value)[0], 201 if value is None else 200)
            self.assertEqual(self.request("GET", "/v1/kv/a%20key%20%E2%98%83"),
                             (200, {"key": "a key ☃", "value": value}))
        self.put("z", 1)
        self.put("A", 2)
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["A", "a key ☃", "z"]}))
        self.assertEqual(self.request("DELETE", "/v1/kv/z"), (204, None))
        self.assertEqual(self.request("DELETE", "/v1/kv/z")[0], 404)
        self.assertEqual(self.request("GET", "/v1/kv/z")[0], 404)

    def test_restart_and_expiry(self):
        self.put("persistent", {"v": 42})
        self.put("temporary", "gone", ttl_seconds=0.25)
        self.stop()
        time.sleep(0.3)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/persistent")[1]["value"], {"v": 42})
        self.assertEqual(self.request("GET", "/v1/kv/temporary")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["persistent"]})
        self.assertNotIn("temporary", json.loads(self.data.read_text())["entries"])

    def test_expired_create_delete_and_ttl_removal(self):
        self.put("expired", 1, ttl_seconds=0.05)
        time.sleep(0.08)
        self.assertEqual(self.request("DELETE", "/v1/kv/expired")[0], 404)
        self.assertEqual(self.put("expired", 2)[0], 201)
        self.put("survivor", 1, ttl_seconds=0.05)
        self.assertEqual(self.put("survivor", 2)[0], 200)
        time.sleep(0.08)
        self.assertEqual(self.request("GET", "/v1/kv/survivor")[0], 200)

    def test_invalid_json_shapes_and_ttls(self):
        for raw in [b"", b"{", b"[]", b"null", b"1", b"{}", b'{"value":NaN}',
                    b'{"value":Infinity}', b'{"value":1e999}', b'{"value":"\xff"}',
                    b'{"value":1,"extra":2}']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request("PUT", "/v1/kv/x", raw=raw)[0], 400)
        for ttl in [None, False, True, 0, -1, "1", [], {}, float("inf"), float("nan"), 10 ** 400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.put("x", 1, ttl_seconds=ttl)[0], 400)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": []})

    def test_invalid_keys_routes_and_methods(self):
        for key in ["", "a/b", "a%2Fb", "%FF", "%", "%2G", "%C0%AF"]:
            self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)
        self.assertEqual(self.request("GET", "/unknown")[0], 404)
        for method in ["POST", "PATCH", "OPTIONS", "CUSTOM"]:
            self.assertEqual(self.request(method, "/v1/kv/key")[0], 405)
        self.assertEqual(self.request("DELETE", "/health")[0], 405)
        self.assertEqual(self.request("PUT", "/v1/keys", {"value": 1})[0], 405)

    def test_body_limit_and_framing(self):
        exact = b'{"value":"' + b"a" * (1024 * 1024 - 12) + b'"}'
        self.assertEqual(len(exact), 1024 * 1024)
        self.assertEqual(self.request("PUT", "/v1/kv/limit", raw=exact)[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/limit", raw=exact + b" ")[0], 413)
        for headers in [{"Content-Length": "-1"}, {"Content-Length": "abc"},
                        {"Transfer-Encoding": "chunked"}]:
            self.assertEqual(self.request("PUT", "/v1/kv/x", raw=b"", headers=headers)[0], 400)

    def test_concurrent_writes_and_restart(self):
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda n: self.put(f"key{n:03}", n), range(60)))
        self.assertTrue(all(status == 201 for status, _ in results))
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda n: self.put("shared", n), range(30)))
        self.assertEqual(sum(status == 201 for status, _ in results), 1)
        self.assertEqual(sum(status == 200 for status, _ in results), 29)
        self.stop()
        self.start()
        self.assertEqual(len(self.request("GET", "/v1/keys")[1]["keys"]), 61)
        for n in range(60):
            self.assertEqual(self.request("GET", f"/v1/kv/key{n:03}")[1]["value"], n)


if __name__ == "__main__":
    unittest.main()
