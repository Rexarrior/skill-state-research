import concurrent.futures
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

from server import MAX_BODY, Store


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
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1",
             "--port", "0", "--data", str(self.data)],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        ready, _, _ = select.select([self.process.stdout], [], [], 5)
        self.assertTrue(ready, "Server did not announce its port")
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING [0-9]+$")
        self.port = int(line.split()[1])
        self.assertGreater(self.port, 0)

    def stop(self):
        if self.process is not None:
            process, self.process = self.process, None
            process.terminate()
            try:
                code = process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                self.fail("SIGTERM did not stop the service")
            remaining = process.stdout.read()
            process.stdout.close()
            self.assertEqual(code, 0)
            self.assertEqual(remaining, "", "Unexpected stdout diagnostics")

    def request(self, method, path, body=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=8)
        try:
            payload = json.dumps(body).encode() if raw is None and body is not None else raw
            connection.request(method, path, body=payload,
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            if response.status == 204:
                self.assertEqual(data, b"")
                return response.status, None
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(data) if method != "HEAD" else None
        finally:
            connection.close()

    def test_crud_and_keys(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        path = "/v1/kv/hello%20%E4%B8%96%E7%95%8C"
        for value in [None, False, 123, 1.25, "text", [1, None], {"x": [True]}]:
            status, body = self.request("PUT", path, {"value": value})
            self.assertIn(status, (200, 201))
            self.assertEqual(self.request("GET", path),
                             (200, {"key": "hello 世界", "value": value}))
        self.assertEqual(self.request("PUT", path, {"value": 2})[0], 200)
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 1})[0], 201)
        self.assertEqual(self.request("GET", "/v1/keys"),
                         (200, {"keys": ["a", "hello 世界"]}))
        self.assertEqual(self.request("DELETE", path)[0], 204)
        self.assertEqual(self.request("DELETE", path)[0], 404)
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_validation(self):
        for raw in [b"{", b"[]", b"null", b"{}", b'{"value": NaN}',
                    b'{"value": Infinity}', b'{"value": 1e999}', b'\xff']:
            with self.subTest(raw=raw):
                self.assertEqual(self.request("PUT", "/v1/kv/x", raw=raw)[0], 400)
        for ttl in [0, -1, True, False, "1", None, [], {}, float("inf")]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request("PUT", "/v1/kv/x",
                                              {"value": 1, "ttl_seconds": ttl})[0], 400)
        for key in ["", "a/b", "%2F", "%FF", "%", "%GG", "%ED%A0%80"]:
            self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)
        self.assertEqual(self.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.request("PATCH", "/v1/kv/x", {})[0], 405)
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/x", raw=b"x" * (MAX_BODY + 1))[0], 413)
        exact = b'{"value":"' + b"x" * (MAX_BODY - 12) + b'"}'
        self.assertEqual(len(exact), MAX_BODY)
        self.assertEqual(self.request("PUT", "/v1/kv/large", raw=exact)[0], 201)

    def test_expiry_and_restart(self):
        self.request("PUT", "/v1/kv/stays", {"value": {"saved": True}})
        self.request("PUT", "/v1/kv/gone", {"value": 1, "ttl_seconds": 0.3})
        self.request("PUT", "/v1/kv/reset", {"value": 1, "ttl_seconds": 0.3})
        self.request("PUT", "/v1/kv/reset", {"value": 2})
        self.stop()
        time.sleep(0.35)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/stays")[1]["value"], {"saved": True})
        self.assertEqual(self.request("GET", "/v1/kv/gone")[0], 404)
        self.assertEqual(self.request("DELETE", "/v1/kv/gone")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys")[1]["keys"], ["reset", "stays"])
        self.assertEqual(self.request("PUT", "/v1/kv/gone", {"value": 3})[0], 201)
        self.request("DELETE", "/v1/kv/stays")
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/stays")[0], 404)

    def test_concurrent_writes(self):
        def put(index):
            return self.request("PUT", f"/v1/kv/key{index:03}", {"value": index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(put, range(50))), [201] * 50)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(lambda i: self.request(
                "PUT", "/v1/kv/shared", {"value": i})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)
        self.stop()
        self.start()
        self.assertEqual(len(self.request("GET", "/v1/keys")[1]["keys"]), 51)
        for i in range(50):
            self.assertEqual(self.request("GET", f"/v1/kv/key{i:03}")[1]["value"], i)

    def test_live_expiry(self):
        self.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.1})
        time.sleep(0.15)
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": []})
        self.assertEqual(self.request("PUT", "/v1/kv/short", {"value": 2})[0], 201)

    def test_shutdown_with_idle_connection(self):
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            sock.sendall(b"GET /health HTTP/1.1\r\n")
            time.sleep(0.05)
            self.stop()

    def test_http_framing_errors(self):
        for headers, status in [("", 411), ("Content-Length: -1\r\n", 400),
                                ("Content-Length: 1\r\nContent-Length: 2\r\n", 400),
                                ("Transfer-Encoding: chunked\r\n", 400),
                                ("Content-Length: 999999999999\r\n", 413)]:
            with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
                sock.sendall(("PUT /v1/kv/x HTTP/1.1\r\nHost: localhost\r\n" +
                              headers + "\r\n").encode())
                response = http.client.HTTPResponse(sock)
                response.begin()
                self.assertEqual(response.status, status)
                self.assertIn("error", json.loads(response.read()))


class StorageTests(unittest.TestCase):
    def test_atomic_failure_preserves_state(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "state.json"
            store = Store(path)
            store.execute("PUT", "key", "original")
            original = path.read_bytes()
            for method in ["PUT", "DELETE"]:
                with patch("server.os.replace", side_effect=OSError("disk failure")):
                    with self.assertRaises(OSError):
                        store.execute(method, "key", "replacement")
                self.assertEqual(store.execute("GET", "key")[1]["value"], "original")
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_corrupt_file_is_rejected(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "state.json"
            path.write_text("not json")
            with self.assertRaises(ValueError):
                Store(path)
            self.assertEqual(path.read_text(), "not json")


if __name__ == "__main__":
    unittest.main()
