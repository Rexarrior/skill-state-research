import concurrent.futures
import http.client
import json
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import quote

from server import MAX_BODY, Store


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name) / "state.json"
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.diagnostics = tempfile.TemporaryFile(mode="w+", dir=self.directory.name)
        self.addCleanup(self.diagnostics.close)
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("server.py")),
             "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE, stderr=self.diagnostics, text=True)
        lines = queue.Queue()
        threading.Thread(target=lambda: lines.put(self.process.stdout.readline()),
                         daemon=True).start()
        line = lines.get(timeout=5)
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
                self.fail("Server did not shut down on SIGTERM")
            finally:
                remaining = process.stdout.read()
                process.stdout.close()
            self.assertEqual(process.returncode, 0)
            self.assertEqual(remaining, "", "Diagnostics leaked onto stdout")

    def request(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            payload = json.dumps(body).encode() if raw is None and body is not None else raw
            connection.request(method, path, body=payload, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_and_json_values(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        path = "/v1/kv/" + quote("snow ☃ + space", safe="")
        for index, value in enumerate([None, False, 12, 1.5, "text", [], {"nested": [True]}]):
            status, body = self.request("PUT", path, {"value": value})
            self.assertEqual(status, 201 if index == 0 else 200)
            self.assertEqual(body, {"key": "snow ☃ + space", "value": value})
            self.assertEqual(self.request("GET", path), (200, body))
        self.assertEqual(self.request("DELETE", path), (204, None))
        self.assertEqual(self.request("GET", path)[0], 404)
        self.assertEqual(self.request("DELETE", path)[0], 404)

    def test_sorted_keys(self):
        keys = ["z", "é", "a", "A", "two words"]
        for key in keys:
            self.request("PUT", "/v1/kv/" + quote(key), {"value": 1})
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": sorted(keys)}))

    def test_restart_and_expiration(self):
        self.request("PUT", "/v1/kv/keep", {"value": [1, 2]})
        self.request("PUT", "/v1/kv/expire", {"value": 2, "ttl_seconds": 0.3})
        self.stop()
        time.sleep(0.35)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/keep"),
                         (200, {"key": "keep", "value": [1, 2]}))
        self.assertEqual(self.request("GET", "/v1/kv/expire")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["keep"]})
        self.assertEqual(self.request("PUT", "/v1/kv/expire", {"value": 3})[0], 201)
        self.request("DELETE", "/v1/kv/keep")
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/keep")[0], 404)
        self.assertEqual(self.request("GET", "/v1/kv/expire")[1]["value"], 3)

    def test_live_expiration_and_ttl_reset(self):
        self.request("PUT", "/v1/kv/gone", {"value": 1, "ttl_seconds": 0.1})
        self.request("PUT", "/v1/kv/reset", {"value": 1, "ttl_seconds": 0.1})
        self.request("PUT", "/v1/kv/reset", {"value": 2})
        time.sleep(0.15)
        self.assertEqual(self.request("DELETE", "/v1/kv/gone")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["reset"]})
        self.request("PUT", "/v1/kv/another", {"value": 3})
        self.assertNotIn("gone", json.loads(self.data.read_text())["entries"])

    def test_invalid_bodies_and_ttls(self):
        bodies = [b"", b"{", b"[]", b"null", b"1", b"{}", b"\xff",
                  b'{"value":NaN}', b'{"value":Infinity}', b'{"value":1e999}']
        for raw in bodies:
            with self.subTest(raw=raw):
                self.assertEqual(self.request("PUT", "/v1/kv/a", raw=raw)[0], 400)
        for ttl in [None, True, False, 0, -1, "2", [], {}, float("inf"), float("nan"), 10**400]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request("PUT", "/v1/kv/a",
                                              {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": []})

    def test_invalid_keys_routes_and_methods(self):
        for key in ["", "%", "%GG", "%FF", "a/b", "a%2Fb", "%ED%A0%80"]:
            with self.subTest(key=key):
                self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)
        self.assertEqual(self.request("GET", "/unknown")[0], 404)
        for method in ["POST", "PATCH", "OPTIONS", "CUSTOM"]:
            self.assertEqual(self.request(method, "/v1/kv/a")[0], 405)
        self.assertEqual(self.request("PUT", "/health", {"value": 1})[0], 405)

    def test_body_limit(self):
        overhead = len(b'{"value":""}')
        payload = b'{"value":"' + b"x" * (MAX_BODY - overhead) + b'"}'
        self.assertEqual(len(payload), MAX_BODY)
        self.assertEqual(self.request("PUT", "/v1/kv/limit", raw=payload)[0], 201)
        # Oversize declared lengths are rejected without waiting for the body.
        self.assertEqual(self.request("PUT", "/v1/kv/large", raw=b"",
                                     headers={"Content-Length": str(MAX_BODY + 1)})[0], 413)

    def test_request_framing(self):
        for headers, expected in [
                ("", 411), ("Content-Length: -1\r\n", 400),
                ("Content-Length: 0\r\nContent-Length: 0\r\n", 400),
                ("Transfer-Encoding: chunked\r\n", 400)]:
            with self.subTest(headers=headers):
                with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
                    sock.sendall(("PUT /v1/kv/a HTTP/1.1\r\nHost: localhost\r\n"
                                  + headers + "\r\n").encode())
                    response = http.client.HTTPResponse(sock)
                    response.begin()
                    self.assertEqual(response.status, expected)
                    self.assertIn("error", json.loads(response.read()))

    def test_concurrent_writes_and_restart(self):
        def write(index):
            return self.request("PUT", f"/v1/kv/k{index:03}", {"value": index})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(write, range(40))), [201] * 40)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.request("PUT", "/v1/kv/shared", {"value": i})[0], range(20)))
        self.assertEqual(results.count(201), 1)
        self.assertEqual(results.count(200), 19)
        self.stop()
        self.start()
        self.assertEqual(len(self.request("GET", "/v1/keys")[1]["keys"]), 41)
        for index in range(40):
            self.assertEqual(self.request("GET", f"/v1/kv/k{index:03}")[1]["value"], index)


class PersistenceTests(unittest.TestCase):
    def test_failed_replace_preserves_memory_and_file(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "data.json"
            store = Store(path)
            store.put("a", 1, None)
            original = path.read_bytes()
            with patch("server.os.replace", side_effect=OSError("disk error")):
                with self.assertRaises(OSError):
                    store.put("a", 2, None)
                with self.assertRaises(OSError):
                    store.delete("a")
            self.assertEqual(store.get("a"), 1)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_corrupt_file_is_preserved(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "data.json"
            path.write_text("broken")
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("server.py")),
                                     "--port", "0", "--data", str(path)],
                                    capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertIn("Startup failed", result.stderr)
            self.assertEqual(path.read_text(), "broken")


if __name__ == "__main__":
    unittest.main()
