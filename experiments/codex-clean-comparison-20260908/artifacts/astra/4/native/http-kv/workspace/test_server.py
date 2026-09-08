"""Standard-library integration tests against a real subprocess server."""

from concurrent.futures import ThreadPoolExecutor
import http.client
import json
from pathlib import Path
import selectors
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import quote

from server import MAX_BODY, Store


ROOT = Path(__file__).resolve().parent


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "state.json"
        self.logs = tempfile.TemporaryFile(dir=self.temp.name)
        self.addCleanup(self.logs.close)
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1",
             "--port", "0", "--data", str(self.path)],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=self.logs, text=True)
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(5), "Server did not announce startup")
        line = self.process.stdout.readline()
        self.assertRegex(line, r"^LISTENING [0-9]+\n$")
        self.port = int(line.split()[1])
        self.assertGreater(self.port, 0)

    def stop(self):
        if self.process is not None:
            process, self.process = self.process, None
            if process.poll() is None:
                process.terminate()
            try:
                result = process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                self.fail("Server failed to shut down")
            finally:
                stdout = process.stdout.read()
                process.stdout.close()
            self.assertEqual(result, 0)
            self.assertEqual(stdout, "", "Unexpected diagnostic on stdout")

    def request(self, method, path, body=None, raw=None):
        if body is not None:
            raw = json.dumps(body).encode()
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request(method, path, body=raw,
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(data) if data else None
        finally:
            connection.close()

    def test_crud_and_sorted_keys(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok"}))
        for key, value in [("z", None), ("a b", [1, True, {"x": "é"}]), ("猫", 3)]:
            path = "/v1/kv/" + quote(key, safe="")
            self.assertEqual(self.request("PUT", path, {"value": value})[0], 201)
            self.assertEqual(self.request("GET", path), (200, {"key": key, "value": value}))
        self.assertEqual(self.request("GET", "/v1/keys"), (200, {"keys": ["a b", "z", "猫"]}))
        self.assertEqual(self.request("PUT", "/v1/kv/z", {"value": False})[0], 200)
        self.assertEqual(self.request("DELETE", "/v1/kv/z"), (204, None))
        self.assertEqual(self.request("DELETE", "/v1/kv/z")[0], 404)
        self.assertEqual(self.request("GET", "/v1/kv/z")[0], 404)

    def test_restart_and_expiration(self):
        self.request("PUT", "/v1/kv/persistent", {"value": {"nested": [1, 2]}})
        self.request("PUT", "/v1/kv/expired", {"value": 2, "ttl_seconds": 0.2})
        self.request("PUT", "/v1/kv/live", {"value": 3, "ttl_seconds": 60})
        self.request("PUT", "/v1/kv/deleted", {"value": 4})
        self.request("DELETE", "/v1/kv/deleted")
        self.stop()
        time.sleep(0.25)
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/persistent")[1]["value"], {"nested": [1, 2]})
        self.assertEqual(self.request("GET", "/v1/kv/expired")[0], 404)
        self.assertEqual(self.request("GET", "/v1/kv/deleted")[0], 404)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["live", "persistent"]})
        self.assertNotIn("expired", json.loads(self.path.read_text())["entries"])

    def test_expired_create_delete_and_ttl_reset(self):
        for key in ("recreate", "delete", "reset"):
            self.request("PUT", "/v1/kv/" + key, {"value": 1, "ttl_seconds": 0.15})
        self.assertEqual(self.request("PUT", "/v1/kv/reset", {"value": 2})[0], 200)
        time.sleep(0.2)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": ["reset"]})
        self.assertEqual(self.request("DELETE", "/v1/kv/delete")[0], 404)
        self.assertEqual(self.request("PUT", "/v1/kv/recreate", {"value": 3})[0], 201)

    def test_invalid_json_shapes_and_ttls(self):
        invalid = [b"", b"{", b"[]", b"null", b"true", b"1", b"{}",
                   b'{"value": NaN}', b'{"value": Infinity}', b'{"value": 1e999}',
                   b'{"value": "\xff"}', b"[" * 2000]
        for raw in invalid:
            with self.subTest(raw=raw[:40]):
                self.assertEqual(self.request("PUT", "/v1/kv/bad", raw=raw)[0], 400)
        for ttl in [None, True, False, 0, -1, "1", [], {}, float("nan"), float("inf")]:
            with self.subTest(ttl=ttl):
                self.assertEqual(self.request("PUT", "/v1/kv/bad", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": []})

    def test_keys_routes_and_methods(self):
        for key in ("", "a/b", "a%2Fb", "%FF", "%C0%AF", "%ED%A0%80", "%", "%2", "%GG"):
            with self.subTest(key=key):
                self.assertEqual(self.request("PUT", "/v1/kv/" + key, {"value": 1})[0], 400)
        for path in ("/", "/unknown", "/v1/key/x"):
            self.assertEqual(self.request("GET", path)[0], 404)
        for method in ("POST", "PATCH", "OPTIONS", "CUSTOM"):
            self.assertEqual(self.request(method, "/v1/kv/a")[0], 405)
        self.assertEqual(self.request("PUT", "/health", {"value": 1})[0], 405)
        self.assertEqual(self.request("PUT", "/v1/kv/%252F", {"value": 1})[0], 201)
        self.assertEqual(self.request("GET", "/v1/kv/%252F")[1]["key"], "%2F")

    def test_body_limit(self):
        body = b'{"value":"' + b"x" * (MAX_BODY - 12) + b'"}'
        self.assertEqual(len(body), MAX_BODY)
        self.assertEqual(self.request("PUT", "/v1/kv/large", raw=body)[0], 201)
        # Advertise oversize without sending it: rejection must be immediate.
        response = self.wire(b"PUT /v1/kv/large HTTP/1.0\r\nContent-Length: 1048577\r\n\r\n")
        self.assertIn(b" 413 ", response.split(b"\r\n")[0])

    def wire(self, request):
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            sock.sendall(request)
            sock.shutdown(socket.SHUT_WR)
            chunks = []
            while chunk := sock.recv(65536):
                chunks.append(chunk)
            return b"".join(chunks)

    def test_bad_framing(self):
        for headers in (b"Content-Length: -1", b"Content-Length: no",
                        b"Content-Length: 2\r\nContent-Length: 2",
                        b"Transfer-Encoding: chunked", b"Content-Length: 12"):
            response = self.wire(b"PUT /v1/kv/x HTTP/1.0\r\n" + headers + b"\r\n\r\n{}")
            self.assertIn(b" 400 ", response.split(b"\r\n")[0])
            self.assertIn("error", json.loads(response.split(b"\r\n\r\n", 1)[1]))

    def test_concurrent_writes(self):
        def put(index):
            return self.request("PUT", f"/v1/kv/key{index:02}", {"value": index})[0]

        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(put, range(40))), [201] * 40)
            statuses = list(pool.map(lambda index: self.request(
                "PUT", "/v1/kv/shared", {"value": index})[0], range(20)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 19)
        self.stop()
        self.start()
        self.assertEqual(len(self.request("GET", "/v1/keys")[1]["keys"]), 41)
        for index in range(40):
            self.assertEqual(self.request("GET", f"/v1/kv/key{index:02}")[1]["value"], index)

    def test_failed_write_preserves_state(self):
        # Exercise rollback directly with an injected atomic-replacement failure.
        self.stop()
        store = Store(self.path)
        store.put("original", 1, None)
        original = self.path.read_bytes()
        with patch("server.os.replace", side_effect=OSError("injected failure")):
            with self.assertRaises(OSError):
                store.put("original", 2, None)
            with self.assertRaises(OSError):
                store.delete("original")
        self.assertEqual(store.get("original"), 1)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])

    def test_corrupt_file_fails_startup(self):
        self.stop()
        self.path.write_text("{broken", encoding="utf-8")
        result = subprocess.run([sys.executable, str(ROOT / "server.py"),
                                 "--port", "0", "--data", str(self.path)],
                                cwd=ROOT, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Startup failed", result.stderr)
        self.assertEqual(self.path.read_text(), "{broken")


if __name__ == "__main__":
    unittest.main()
