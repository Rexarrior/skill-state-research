"""End-to-end tests: python3 -m unittest -v."""

from concurrent.futures import ThreadPoolExecutor
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
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name) / "state.json"
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.log = tempfile.TemporaryFile(mode="w+b", dir=ROOT)
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1",
             "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE, stderr=self.log, text=True)
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING [0-9]+$")
        self.port = int(line.split()[1])
        self.assertGreater(self.port, 0)

    def stop(self):
        if self.process is not None:
            process, self.process = self.process, None
            process.terminate()
            try:
                output, _ = process.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                self.fail("SIGTERM did not stop the server")
            finally:
                self.log.seek(0)
                diagnostics = self.log.read().decode()
                self.log.close()
            self.assertEqual(process.returncode, 0, diagnostics)
            self.assertEqual(output, "", "Diagnostics leaked to stdout")

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=8)
        payload = raw if raw is not None else (None if body is None else json.dumps(body))
        try:
            connection.request(method, path, payload, headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            decoded = json.loads(data) if data else None
            if response.status >= 400 and method != "HEAD":
                self.assertIsInstance(decoded.get("error"), str)
            return response.status, decoded
        finally:
            connection.close()

    def put(self, key, value, **extras):
        return self.request("PUT", "/v1/kv/" + quote(key, safe=""),
                            {"value": value, **extras})

    def test_crud_and_arbitrary_values(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": []}))
        for value in [None, True, 7, 2.5, "text", [1, None], {"nested": [False]}]:
            self.assertIn(self.put("hello 世界", value)[0], (200, 201))
            self.assertEqual(self.request("GET", "/v1/kv/hello%20%E4%B8%96%E7%95%8C"),
                             (200, {"key": "hello 世界", "value": value}))
        self.assertEqual(self.put("hello 世界", "replacement")[0], 200)
        self.assertEqual(self.request("DELETE", "/v1/kv/hello%20%E4%B8%96%E7%95%8C"),
                         (204, None))
        self.assertEqual(self.request("DELETE", "/v1/kv/absent")[0], 404)
        self.assertEqual(self.request("GET", "/v1/kv/absent")[0], 404)

    def test_keys_sorted_and_encoding(self):
        keys = ["z", "a b", "é", "A", "%2F", "+", "?", "#"]
        for key in keys:
            self.assertEqual(self.put(key, key)[0], 201)
            self.assertEqual(self.request("GET", "/v1/kv/" + quote(key, safe=""))[1]["key"], key)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": sorted(keys)})

    def test_invalid_keys(self):
        for key in ["", "a/b", "%2f", "a%2Fb", "%FF", "%C0%AF", "%", "%XY", "%ED%A0%80"]:
            with self.subTest(key=key):
                self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)

    def test_invalid_json_and_shapes(self):
        for raw in ["", "{", "[]", "null", "7", '"value"', '{}',
                    '{"value":NaN}', '{"value":Infinity}', '{"value":1e999}',
                    '{"value":1,"extra":2}', b'{"value":"\xff"}']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request("PUT", "/v1/kv/key", raw=raw)[0], 400)

    def test_invalid_ttl(self):
        for ttl in [None, True, False, 0, -1, "1", [], {}, float("nan"),
                    float("inf"), -float("inf"), 10 ** 400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.put("key", 1, ttl_seconds=ttl)[0], 400)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": []})

    def test_ttl_expiration(self):
        for key in ["get", "delete", "replace"]:
            self.assertEqual(self.put(key, 1, ttl_seconds=0.15)[0], 201)
        time.sleep(0.25)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": []})
        self.assertEqual(self.request("GET", "/v1/kv/get")[0], 404)
        self.assertEqual(self.request("DELETE", "/v1/kv/delete")[0], 404)
        self.assertEqual(self.put("replace", 2)[0], 201)

    def test_replacement_removes_ttl(self):
        self.put("key", 1, ttl_seconds=0.1)
        self.assertEqual(self.put("key", 2)[0], 200)
        time.sleep(0.2)
        self.assertEqual(self.request("GET", "/v1/kv/key")[1]["value"], 2)

    def test_restart_and_offline_expiry(self):
        self.put("permanent", {"saved": True})
        self.put("temporary", "gone", ttl_seconds=0.3)
        self.put("deleted", 1)
        self.request("DELETE", "/v1/kv/deleted")
        self.stop()
        time.sleep(0.4)
        self.start()
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["permanent"]})
        self.assertEqual(self.request("GET", "/v1/kv/permanent")[1]["value"], {"saved": True})
        self.assertNotIn("temporary", json.loads(self.data.read_text())["entries"])

    def test_acknowledged_write_survives_abrupt_exit(self):
        self.put("durable", [1, 2, 3])
        self.process.kill()
        self.process.communicate(timeout=8)
        self.process = None
        self.log.close()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/durable")[1]["value"], [1, 2, 3])

    def test_concurrent_writes(self):
        with ThreadPoolExecutor(max_workers=12) as executor:
            results = list(executor.map(lambda i: self.put(f"key{i:03}", i)[0], range(60)))
        self.assertEqual(results, [201] * 60)
        with ThreadPoolExecutor(max_workers=12) as executor:
            results = list(executor.map(lambda i: self.put("shared", i)[0], range(30)))
        self.assertEqual(results.count(201), 1)
        self.assertEqual(results.count(200), 29)
        self.stop()
        self.start()
        self.assertEqual(len(self.request("GET", "/v1/keys")[1]["keys"]), 61)

    def test_limit_and_framing(self):
        # A valid body of exactly 1 MiB is accepted; the next byte is rejected.
        overhead = len('{"value":""}')
        raw = '{"value":"' + 'x' * (1024 * 1024 - overhead) + '"}'
        self.assertEqual(self.request("PUT", "/v1/kv/large", raw=raw)[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/large", raw=raw + " ")[0], 413)
        for headers in [{"Content-Length": "-1"}, {"Content-Length": "abc"},
                        {"Transfer-Encoding": "chunked"}]:
            self.assertEqual(self.request("PUT", "/v1/kv/key", raw="", headers=headers)[0], 400)

    def test_routes_and_methods(self):
        for path in ["/", "/v2/keys", "/v1/kv", "/health/", "/nope"]:
            self.assertEqual(self.request("GET", path)[0], 404)
        for method in ["POST", "PATCH", "OPTIONS", "BOGUS"]:
            self.assertEqual(self.request(method, "/v1/kv/key")[0], 405)
        self.assertEqual(self.request("PUT", "/health", {"value": 1})[0], 405)
        self.assertEqual(self.request("DELETE", "/v1/keys")[0], 405)


if __name__ == "__main__":
    unittest.main()
