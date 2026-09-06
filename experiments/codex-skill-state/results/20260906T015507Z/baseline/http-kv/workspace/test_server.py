import http.client
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import quote


class RunningServer:
    def __init__(self, data_path: Path):
        self.process = subprocess.Popen(
            [
                sys.executable,
                "server.py",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--data",
                str(data_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline()
        if not line.startswith("LISTENING "):
            diagnostics = self.process.stderr.read()
            self.process.wait(timeout=5)
            self.process.stdout.close()
            self.process.stderr.close()
            raise RuntimeError(f"server did not start: {line!r} {diagnostics!r}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            if isinstance(body, (dict, list)):
                body = json.dumps(body)
                headers = {"Content-Type": "application/json", **(headers or {})}
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            raw = response.read()
            return (response.status, response.getheader("Content-Type"), raw)
        finally:
            connection.close()

    def stop(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.data_path = Path(self.tempdir.name) / "state.json"
        self.server = RunningServer(self.data_path)

    def tearDown(self):
        self.server.stop()
        self.tempdir.cleanup()

    def json_request(self, method, path, body=None, headers=None):
        status, content_type, raw = self.server.request(method, path, body, headers)
        self.assertEqual(content_type, "application/json")
        return status, json.loads(raw) if raw else None

    def test_crud_unicode_sorting_and_restart(self):
        encoded = quote("two words", safe="")
        self.assertEqual(self.json_request("PUT", f"/v1/kv/{encoded}", {"value": [1, None]})[0], 201)
        self.assertEqual(self.json_request("PUT", "/v1/kv/z", {"value": False})[0], 201)
        self.assertEqual(self.json_request("PUT", f"/v1/kv/{encoded}", {"value": {"x": 2}})[0], 200)
        self.assertEqual(
            self.json_request("GET", f"/v1/kv/{encoded}"),
            (200, {"key": "two words", "value": {"x": 2}}),
        )
        self.assertEqual(self.json_request("GET", "/v1/keys"), (200, {"keys": ["two words", "z"]}))

        self.server.stop()
        self.server = RunningServer(self.data_path)
        self.assertEqual(self.json_request("GET", f"/v1/kv/{encoded}")[0], 200)
        self.assertEqual(self.json_request("DELETE", f"/v1/kv/{encoded}"), (204, None))
        self.assertEqual(self.json_request("DELETE", f"/v1/kv/{encoded}")[0], 404)

    def test_ttl_expires_and_does_not_return_after_restart(self):
        self.assertEqual(
            self.json_request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.05})[0],
            201,
        )
        time.sleep(0.08)
        self.assertEqual(self.json_request("GET", "/v1/kv/short")[0], 404)
        self.server.stop()
        self.server = RunningServer(self.data_path)
        self.assertEqual(self.json_request("GET", "/v1/keys"), (200, {"keys": []}))

        self.assertEqual(
            self.json_request("PUT", "/v1/kv/restart", {"value": 2, "ttl_seconds": 0.05})[0],
            201,
        )
        self.server.stop()
        time.sleep(0.08)
        self.server = RunningServer(self.data_path)
        self.assertEqual(self.json_request("GET", "/v1/keys"), (200, {"keys": []}))

    def test_validation_routes_and_body_limit(self):
        cases = [
            ("GET", "/missing", None, None, 404),
            ("POST", "/health", None, None, 405),
            ("BREW", "/health", None, None, 405),
            ("GET", "/v1/kv/", None, None, 400),
            ("GET", "/v1/kv/a%2Fb", None, None, 400),
            ("GET", "/v1/kv/%FF", None, None, 400),
            ("PUT", "/v1/kv/a", "{", {"Content-Type": "application/json"}, 400),
            ("PUT", "/v1/kv/a", [], None, 400),
            ("PUT", "/v1/kv/a", "null", {"Content-Type": "application/json"}, 400),
            ("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": 0}, None, 400),
            ("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": True}, None, 400),
            ("PUT", "/v1/kv/a", {"value": 1, "extra": 2}, None, 400),
        ]
        for method, path, body, headers, expected in cases:
            with self.subTest(method=method, path=path, body=body):
                self.assertEqual(self.json_request(method, path, body, headers)[0], expected)
        self.assertEqual(
            self.json_request("PUT", "/v1/kv/huge", {"value": 1, "ttl_seconds": 10**400})[0],
            201,
        )
        oversized = b"x" * (1024 * 1024 + 1)
        self.assertEqual(
            self.json_request(
                "PUT", "/v1/kv/a", oversized, {"Content-Type": "application/json"}
            )[0],
            413,
        )

    def test_concurrent_writes_are_not_lost(self):
        statuses = []

        def write(number):
            statuses.append(
                self.json_request("PUT", f"/v1/kv/k{number:02d}", {"value": number})[0]
            )

        threads = [threading.Thread(target=write, args=(number,)) for number in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 20)
        status, document = self.json_request("GET", "/v1/keys")
        self.assertEqual(status, 200)
        self.assertEqual(len(document["keys"]), 20)


if __name__ == "__main__":
    unittest.main()
