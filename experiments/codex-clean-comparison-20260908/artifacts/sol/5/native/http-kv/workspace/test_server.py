"""Black-box self-tests for server.py."""

from __future__ import annotations

import http.client
import json
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent


class ServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.data = Path(self.temporary.name) / "store.json"
        self.process: subprocess.Popen[str] | None = None
        self.start()

    def tearDown(self) -> None:
        self.stop()
        self.temporary.cleanup()

    def start(self) -> None:
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "server.py"),
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--data",
                str(self.data),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING [0-9]+$")
        self.port = int(line.split()[1])

    def stop(self) -> None:
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                self.process.wait(timeout=5)
                self.assertEqual(self.process.returncode, 0)
            if self.process.stdout is not None:
                self.process.stdout.close()
            if self.process.stderr is not None:
                self.process.stderr.close()
        self.process = None

    def request(self, method: str, path: str, body: object | bytes | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        headers: dict[str, str] = {}
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            result = json.loads(raw) if raw else None
            headers_out = dict(response.getheaders())
        finally:
            connection.close()
        return response.status, result, headers_out

    def test_crud_keys_and_persistence(self) -> None:
        key = "snow ☃+"
        path = "/v1/kv/" + quote(key, safe="")
        self.assertEqual(self.request("PUT", path, {"value": [1, None]})[0], 201)
        self.assertEqual(self.request("PUT", path, {"value": {"x": True}})[0], 200)
        self.assertEqual(self.request("GET", path)[:2], (200, {"key": key, "value": {"x": True}}))
        self.assertEqual(self.request("GET", "/v1/keys")[1], {"keys": [key]})

        self.stop()
        self.start()
        self.assertEqual(self.request("GET", path)[0], 200)
        status, body, headers = self.request("DELETE", path)
        self.assertEqual((status, body), (204, None))
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_ttl_validation_errors_and_limit(self) -> None:
        path = "/v1/kv/short"
        self.assertEqual(self.request("PUT", path, {"value": 1, "ttl_seconds": 0.12})[0], 201)
        time.sleep(0.18)
        self.assertEqual(self.request("GET", path)[0], 404)
        for ttl in (0, -1, None, True, "1"):
            self.assertEqual(self.request("PUT", path, {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.request("PUT", path, b"not json")[0], 400)
        oversized = b" " * (1024 * 1024 + 1)
        self.assertEqual(self.request("PUT", path, oversized)[0], 413)
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("POST", "/health")[0], 405)

    def test_concurrent_writes_remain_valid(self) -> None:
        def write(number: int) -> int:
            return self.request("PUT", f"/v1/kv/k{number:02d}", {"value": number})[0]

        with ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(write, range(24)))
        self.assertEqual(statuses, [201] * 24)
        self.assertEqual(len(self.request("GET", "/v1/keys")[1]["keys"]), 24)
        json.loads(self.data.read_text())


if __name__ == "__main__":
    unittest.main()
