"""Integration tests; run with python3 -m unittest -v."""
import concurrent.futures
import http.client
import json
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import quote


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.data = Path(self.directory.name) / "nested" / "state.json"
        self.process = None
        self.start()

    def tearDown(self):
        self.stop()
        self.directory.cleanup()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("server.py")),
             "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.assertTrue(select.select([self.process.stdout], [], [], 5)[0], "Startup timed out")
        line = self.process.stdout.readline()
        self.assertRegex(line, r"^LISTENING [0-9]+\n$")
        self.port = int(line.split()[1])

    def stop(self):
        if self.process is not None:
            process, self.process = self.process, None
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=7)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                self.fail("SIGTERM did not stop the service")
            self.assertEqual(process.stdout.read(), "")
            process.stdout.close()
            self.assertEqual(process.returncode, 0)

    def request(self, method, path, obj=None, raw=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=8)
        try:
            body = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
            conn.request(method, path, body, headers or {})
            response = conn.getresponse()
            data = response.read()
            if data:
                self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(data) if data else None
        finally:
            conn.close()

    def test_crud_and_keys(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        key = "snow ☃ + space"
        path = "/v1/kv/" + quote(key, safe="")
        value = {"array": [None, True, 3, "hello"], "nested": {"x": 4.5}}
        self.assertEqual(self.request("PUT", path, {"value": value}), (201, {"key": key, "value": value}))
        self.assertEqual(self.request("GET", path), (200, {"key": key, "value": value}))
        self.assertEqual(self.request("PUT", path, {"value": None})[0], 200)
        self.request("PUT", "/v1/kv/a", {"value": False})
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["a", key]}))
        self.assertEqual(self.request("DELETE", path), (204, None))
        self.assertEqual(self.request("DELETE", path)[0], 404)
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_restart_and_expiry(self):
        self.request("PUT", "/v1/kv/permanent", {"value": [1, 2]})
        self.request("PUT", "/v1/kv/expires", {"value": "short", "ttl_seconds": .3})
        self.request("PUT", "/v1/kv/deleted", {"value": "gone"})
        self.request("DELETE", "/v1/kv/deleted")
        self.stop()
        time.sleep(.35)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/permanent"), (200, {"key": "permanent", "value": [1, 2]}))
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["permanent"]}))
        self.assertEqual(self.request("GET", "/v1/kv/expires")[0], 404)
        self.assertEqual(self.request("GET", "/v1/kv/deleted")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/expires", {"value": 2})[0], 201)
        self.request("PUT", "/v1/kv/ttl", {"value": 1, "ttl_seconds": .1})
        time.sleep(.15)
        self.assertEqual(self.request("DELETE", "/v1/kv/ttl")[0], 404)
        self.request("PUT", "/v1/kv/ttl", {"value": 2, "ttl_seconds": .1})
        self.request("PUT", "/v1/kv/ttl", {"value": 3})
        time.sleep(.15)
        self.assertEqual(self.request("GET", "/v1/kv/ttl")[1]["value"], 3)
        state = json.loads(self.data.read_text())
        self.assertNotIn("deleted", state["entries"])

    def test_invalid_requests(self):
        for raw in [b"", b"{", b"[]", b"null", b"42", b"{}", b'{"value": NaN}',
                    b'{"value": 1e999}', b'{"value": "\xff"}', b'{"value": 0, "extra": 1}']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request("PUT", "/v1/kv/k", raw=raw)[0], 400)
        for ttl in [None, True, False, 0, -1, "2", [], {}, float("inf"), float("nan"), 10**400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request("PUT", "/v1/kv/k", {"value": 1, "ttl_seconds": ttl})[0], 400)
        for key in ["", "%2F", "a/b", "%FF", "%", "%GG", "%C0%AF"]:
            with self.subTest(key=key):
                self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)
        for method in ["POST", "PATCH", "OPTIONS", "TRACE", "CUSTOM"]:
            self.assertEqual(self.request(method, "/v1/kv/k")[0], 405)
        self.assertEqual(self.request("PUT", "/health", {"value": 1})[0], 405)
        self.assertEqual(self.request("GET", "/unknown")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/k", raw=b"{}", headers={"Content-Length": "-1"})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/k", raw=b"{}", headers={"Transfer-Encoding": "chunked"})[0], 400)

    def test_body_limit(self):
        raw = b'{"value":"' + b'x' * (1024 * 1024 - 12) + b'"}'
        self.assertEqual(len(raw), 1024 * 1024)
        self.assertEqual(self.request("PUT", "/v1/kv/large", raw=raw)[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/large", raw=raw + b" ")[0], 413)

    def test_concurrent_writes_and_persistence(self):
        def put(i):
            return self.request("PUT", f"/v1/kv/key{i:03}", {"value": i})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(48))), [201] * 48)
            statuses = list(pool.map(lambda i: self.request("PUT", "/v1/kv/shared", {"value": i})[0], range(24)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 23)
        self.stop()
        self.start()
        self.assertEqual(len(self.request("GET", "/v1/keys")[1]["keys"]), 49)
        for i in range(48):
            self.assertEqual(self.request("GET", f"/v1/kv/key{i:03}")[1]["value"], i)
        self.assertEqual(list(self.data.parent.glob(".kv-*")), [])


if __name__ == "__main__":
    unittest.main()
