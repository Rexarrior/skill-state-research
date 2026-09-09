"""Integration tests using only the Python standard library."""

from concurrent.futures import ThreadPoolExecutor
import http.client
import json
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import quote

from server import Store


ROOT = Path(__file__).resolve().parent


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name) / "data.json"
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.errors = tempfile.TemporaryFile(mode="w+", dir=self.directory.name)
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1",
             "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE, stderr=self.errors, text=True, cwd=ROOT)
        self.assertTrue(select.select([self.process.stdout], [], [], 5)[0], "Startup timed out")
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
                self.fail("SIGTERM did not shut down cleanly")
            remaining = process.stdout.read()
            process.stdout.close()
            self.errors.seek(0)
            errors = self.errors.read()
            self.errors.close()
            self.assertEqual(process.returncode, 0, errors)
            self.assertEqual(remaining, "", "Diagnostics leaked to stdout")

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            connection.request(method, path, payload, headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_and_sorted_unicode_keys(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        for key in ["z", "a b", "café", "a+b"]:
            path = "/v1/kv/" + quote(key, safe="")
            value = {"nested": [None, True, 42, "hello"]}
            self.assertEqual(self.request("PUT", path, {"value": value})[0], 201)
            self.assertEqual(self.request("GET", path), (200, {"key": key, "value": value}))
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["a b", "a+b", "café", "z"]}))
        self.assertEqual(self.request("PUT", "/v1/kv/z", {"value": None})[0], 200)
        self.assertEqual(self.request("DELETE", "/v1/kv/z"), (204, None))
        self.assertEqual(self.request("DELETE", "/v1/kv/z")[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/z")[0], 404)
        self.assertEqual(len(self.request("GET", "/v1/keys")[1]["keys"]), 3)

    def test_expiry_and_restart(self):
        self.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.15})
        self.request("PUT", "/v1/kv/long", {"value": 2, "ttl_seconds": 30})
        self.stop()
        time.sleep(0.2)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)
        self.assertEqual(self.request("DELETE", "/v1/kv/short")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["long"]})
        self.assertEqual(self.request("PUT", "/v1/kv/short", {"value": 3})[0], 201)
        self.request("PUT", "/v1/kv/reset", {"value": 1, "ttl_seconds": 0.1})
        self.assertEqual(self.request("PUT", "/v1/kv/reset", {"value": 2})[0], 200)
        time.sleep(0.15)
        self.assertEqual(self.request("GET", "/v1/kv/reset")[1]["value"], 2)

    def test_invalid_requests(self):
        for raw in [b"{", b"", b"[]", b"null", b"{}", b'{"value":NaN}', b'{"value":1e999}', b'\xff']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request("PUT", "/v1/kv/a", raw=raw)[0], 400)
        for ttl in [0, -1, True, False, None, "1", [], {}, float("inf"), float("nan")]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": ttl})[0], 400)
        for key in ["", "a/b", "a%2Fb", "%FF", "%", "%XY", "%C0%AF"]:
            with self.subTest(key=key):
                self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)
        for method in ["POST", "PATCH", "OPTIONS", "BREW"]:
            self.assertEqual(self.request(method, "/v1/kv/a")[0], 405)
        self.assertEqual(self.request("PUT", "/health", {"value": 1})[0], 405)
        self.assertEqual(self.request("GET", "/unknown")[0], 404)
        self.assertEqual(self.request("GET", "/health", headers={"Content-Length": "-1"})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/a", headers={"Transfer-Encoding": "chunked"})[0], 400)

    def test_body_limit(self):
        prefix, suffix = b'{"value":"', b'"}'
        body = prefix + b"x" * (1024 * 1024 - len(prefix) - len(suffix)) + suffix
        self.assertEqual(self.request("PUT", "/v1/kv/large", raw=body)[0], 201)
        # Oversized requests are rejected from headers without waiting for a body.
        self.assertEqual(self.request("PUT", "/v1/kv/large", headers={"Content-Length": str(len(body) + 1)})[0], 413)

    def test_concurrent_writes_survive_restart(self):
        def put(index):
            return self.request("PUT", f"/v1/kv/key{index:03}", {"value": index})[0]
        with ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(60))), [201] * 60)
            statuses = list(pool.map(lambda _: self.request("PUT", "/v1/kv/shared", {"value": 1})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)
        self.stop()
        self.assertEqual(len(json.loads(self.data.read_text())["entries"]), 61)
        self.start()
        for index in range(60):
            self.assertEqual(self.request("GET", f"/v1/kv/key{index:03}")[1]["value"], index)

    def test_incomplete_request_does_not_block_shutdown_forever(self):
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as connection:
            connection.sendall(b"PUT /v1/kv/a HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{")
            self.stop()


class PersistenceTests(unittest.TestCase):
    def test_failed_replace_preserves_memory_and_disk(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "data.json"
            store = Store(path)
            store.operate("PUT", "a", "original")
            original = path.read_bytes()
            with patch("server.os.replace", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    store.operate("PUT", "a", "replacement")
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(store.operate("GET", "a")[1]["value"], "original")
            self.assertEqual(list(Path(directory).iterdir()), [path])


if __name__ == "__main__":
    unittest.main()
