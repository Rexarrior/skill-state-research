import http.client
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent


class RunningServer:
    def __init__(self, data: Path):
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "server.py"),
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--data",
                str(data),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            raise RuntimeError(f"server did not start: {line}")
        self.port = int(line.split()[1])
        self.closed = False

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.process.terminate()
        self.process.wait(timeout=5)
        if self.process.returncode != 0:
            assert self.process.stderr is not None
            raise RuntimeError(self.process.stderr.read())
        assert self.process.stdout is not None
        assert self.process.stderr is not None
        self.process.stdout.close()
        self.process.stderr.close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body).encode()
        request_headers = {} if headers is None else dict(headers)
        if encoded is not None:
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, encoded, request_headers)
        response = connection.getresponse()
        content = response.read()
        result = (response.status, dict(response.getheaders()), content)
        connection.close()
        return result


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data = Path(self.temporary.name) / "nested" / "store.json"
        self.server = RunningServer(self.data)

    def tearDown(self):
        self.server.close()
        self.temporary.cleanup()

    def test_crud_unicode_sorting_and_restart(self):
        key = "snow man ☃"
        status, _, _ = self.server.request(
            "PUT", "/v1/kv/" + quote(key), {"value": {"answer": 42}}
        )
        self.assertEqual(status, 201)
        self.assertEqual(
            self.server.request("PUT", "/v1/kv/z", {"value": None})[0], 201
        )
        self.assertEqual(
            json.loads(self.server.request("GET", "/v1/keys")[2]),
            {"keys": [key, "z"]},
        )
        self.server.close()
        self.server = RunningServer(self.data)
        status, headers, content = self.server.request("GET", "/v1/kv/" + quote(key))
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(json.loads(content), {"key": key, "value": {"answer": 42}})
        self.assertEqual(self.server.request("DELETE", "/v1/kv/z")[0], 204)
        self.assertEqual(self.server.request("GET", "/v1/kv/z")[0], 404)

    def test_ttl_and_validation(self):
        self.assertEqual(
            self.server.request(
                "PUT", "/v1/kv/short", {"value": "gone", "ttl_seconds": 0.05}
            )[0],
            201,
        )
        time.sleep(0.08)
        self.assertEqual(self.server.request("GET", "/v1/kv/short")[0], 404)
        for body in (
            [],
            {},
            {"value": 1, "ttl_seconds": 0},
            {"value": 1, "ttl_seconds": True},
            {"value": 1, "ttl_seconds": None},
            {"value": 1, "extra": 2},
        ):
            self.assertEqual(self.server.request("PUT", "/v1/kv/k", body)[0], 400)
        self.assertEqual(self.server.request("GET", "/v1/kv/%2F")[0], 400)
        self.assertEqual(self.server.request("POST", "/health")[0], 405)
        self.assertEqual(self.server.request("BREW", "/health")[0], 405)
        self.assertEqual(self.server.request("GET", "/missing")[0], 404)

    def test_expired_value_does_not_return_after_restart(self):
        self.assertEqual(
            self.server.request(
                "PUT", "/v1/kv/temporary", {"value": 1, "ttl_seconds": 0.05}
            )[0],
            201,
        )
        self.server.close()
        time.sleep(0.08)
        self.server = RunningServer(self.data)
        self.assertEqual(self.server.request("GET", "/v1/kv/temporary")[0], 404)
        self.assertEqual(
            json.loads(self.server.request("GET", "/v1/keys")[2]), {"keys": []}
        )

    def test_body_limit(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.putrequest("PUT", "/v1/kv/large")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(1024 * 1024 + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        connection.close()

    def test_concurrent_writes_remain_durable(self):
        failures = []

        def write(number):
            try:
                status, _, _ = self.server.request(
                    "PUT", f"/v1/kv/key-{number:02d}", {"value": number}
                )
                if status != 201:
                    failures.append(status)
            except Exception as exc:  # surfaced with context by the assertion below
                failures.append(exc)

        threads = [threading.Thread(target=write, args=(number,)) for number in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(failures, [])
        self.server.close()
        self.server = RunningServer(self.data)
        keys = json.loads(self.server.request("GET", "/v1/keys")[2])["keys"]
        self.assertEqual(keys, [f"key-{number:02d}" for number in range(20)])


if __name__ == "__main__":
    unittest.main()
