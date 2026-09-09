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


ROOT = Path(__file__).parent


class Service:
    def __init__(self, data: Path):
        self.data = data

    def __enter__(self):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            stderr = self.process.stderr.read()
            raise AssertionError(f"server failed: {line!r} {stderr!r}")
        self.port = int(line.split()[1])
        return self

    def __exit__(self, *_args):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=3)
        self.process.stdout.close()
        self.process.stderr.close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        supplied = dict(headers or {})
        if body is not None and not isinstance(body, (bytes, str)):
            body = json.dumps(body)
            supplied.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=body, headers=supplied)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, dict(response.getheaders()), raw)
        connection.close()
        return result


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "nested" / "state.json"

    def tearDown(self):
        self.temp.cleanup()

    def decoded(self, result):
        status, headers, raw = result
        self.assertEqual(headers.get("Content-Type"), "application/json")
        return status, json.loads(raw)

    def test_crud_unicode_keys_sorting_and_persistence(self):
        with Service(self.data) as service:
            self.assertEqual(self.decoded(service.request("GET", "/health")), (200, {"status": "ok"}))
            key = "snow ☃ key"
            path = "/v1/kv/" + quote(key)
            self.assertEqual(self.decoded(service.request("PUT", path, {"value": [1, None]}))[0], 201)
            self.assertEqual(self.decoded(service.request("PUT", path, {"value": {"x": True}}))[0], 200)
            service.request("PUT", "/v1/kv/z", {"value": 3})
            self.assertEqual(self.decoded(service.request("GET", path)), (200, {"key": key, "value": {"x": True}}))
            self.assertEqual(self.decoded(service.request("GET", "/v1/keys")), (200, {"keys": [key, "z"]}))
        with Service(self.data) as service:
            self.assertEqual(self.decoded(service.request("GET", path))[0], 200)
            self.assertEqual(service.request("DELETE", path)[0], 204)
            self.assertEqual(self.decoded(service.request("DELETE", path))[0], 404)

    def test_ttl_expires_and_does_not_return_after_restart(self):
        with Service(self.data) as service:
            result = service.request("PUT", "/v1/kv/brief", {"value": "x", "ttl_seconds": 0.12})
            self.assertEqual(result[0], 201)
            time.sleep(0.2)
            self.assertEqual(service.request("GET", "/v1/kv/brief")[0], 404)
        with Service(self.data) as service:
            self.assertEqual(service.request("GET", "/v1/kv/brief")[0], 404)
            self.assertEqual(self.decoded(service.request("GET", "/v1/keys"))[1], {"keys": []})

    def test_validation_routes_and_body_limit(self):
        with Service(self.data) as service:
            cases = [
                ("PUT", "/v1/kv/x", b"not json", {}, 400),
                ("PUT", "/v1/kv/x", [], {}, 400),
                ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": 0}, {}, 400),
                ("PUT", "/v1/kv/x", {"value": 1, "ttl_seconds": True}, {}, 400),
                ("PUT", "/v1/kv/x", {"value": 1, "extra": 2}, {}, 400),
                ("GET", "/v1/kv/", None, {}, 400),
                ("GET", "/v1/kv/a%2Fb", None, {}, 400),
                ("GET", "/unknown", None, {}, 404),
                ("POST", "/health", b"", {}, 405),
            ]
            for method, path, body, headers, expected in cases:
                with self.subTest(method=method, path=path, body=body):
                    result = service.request(method, path, body, headers)
                    self.assertEqual(result[0], expected)
                    self.decoded(result)
            large = b'{"value":"' + b"x" * (1024 * 1024) + b'"}'
            self.assertEqual(service.request("PUT", "/v1/kv/x", large)[0], 413)

    def test_concurrent_writes_leave_valid_complete_file(self):
        with Service(self.data) as service:
            statuses = []
            def write(number):
                statuses.append(service.request("PUT", f"/v1/kv/k{number}", {"value": number})[0])
            threads = [threading.Thread(target=write, args=(number,)) for number in range(20)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertTrue(all(status == 201 for status in statuses))
            self.assertEqual(len(self.decoded(service.request("GET", "/v1/keys"))[1]["keys"]), 20)
            self.assertEqual(len(json.loads(self.data.read_text())["entries"]), 20)


if __name__ == "__main__":
    unittest.main()
