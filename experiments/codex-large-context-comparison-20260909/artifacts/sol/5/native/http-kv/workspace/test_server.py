"""End-to-end tests for server.py, using only the standard library."""

from __future__ import annotations

import http.client
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).parent


class ServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.data = Path(self.temporary.name) / "state.json"
        self.process: subprocess.Popen[str] | None = None
        self.start_server()

    def tearDown(self) -> None:
        self.stop_server()
        self.temporary.cleanup()

    def start_server(self) -> None:
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
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline().strip()
        self.assertRegex(line, r"^LISTENING \d+$")
        self.port = int(line.split()[1])

    def stop_server(self) -> None:
        if self.process is not None:
            if self.process.poll() is None:
                self.process.send_signal(signal.SIGTERM)
                self.process.wait(timeout=5)
            if self.process.stdout is not None:
                self.process.stdout.close()
        self.process = None

    def request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, object] | None, dict[str, str]]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        response_body = response.read()
        result_headers = dict(response.getheaders())
        status = response.status
        connection.close()
        parsed = json.loads(response_body) if response_body else None
        return status, parsed, result_headers

    def put(self, key: str, document: object) -> tuple[int, dict[str, object] | None]:
        status, body, _ = self.request(
            "PUT",
            "/v1/kv/" + quote(key, safe=""),
            json.dumps(document).encode(),
            {"Content-Type": "application/json"},
        )
        return status, body

    def test_crud_sorting_and_encoded_keys(self) -> None:
        self.assertEqual(self.request("GET", "/health")[0:2], (200, {"status": "ok"}))
        self.assertEqual(self.put("two words", {"value": [1, None]})[0], 201)
        self.assertEqual(self.put("alpha", {"value": "a"})[0], 201)
        self.assertEqual(self.put("alpha", {"value": "replaced"})[0], 200)
        self.assertEqual(
            self.request("GET", "/v1/kv/two%20words")[0:2],
            (200, {"key": "two words", "value": [1, None]}),
        )
        self.assertEqual(
            self.request("GET", "/v1/keys")[1],
            {"keys": ["alpha", "two words"]},
        )
        status, body, headers = self.request("DELETE", "/v1/kv/alpha")
        self.assertEqual((status, body), (204, None))
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(self.request("GET", "/v1/kv/alpha")[0], 404)

    def test_validation_expiration_and_limit(self) -> None:
        for bad_ttl in (None, True, 0, -1, "1"):
            self.assertEqual(self.put("bad", {"value": 1, "ttl_seconds": bad_ttl})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/x", b"not json")[0], 400)
        self.assertEqual(self.request("GET", "/v1/kv/%FF")[0], 400)
        self.assertEqual(self.request("GET", "/v1/kv/a%2Fb")[0], 400)
        self.assertEqual(self.request("POST", "/health")[0], 405)
        self.assertEqual(self.request("WAT", "/health")[0], 405)
        oversized = b" " * (1024 * 1024 + 1)
        self.assertEqual(self.request("PUT", "/v1/kv/large", oversized)[0], 413)

        self.assertEqual(self.put("brief", {"value": 1, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.08)
        self.assertEqual(self.request("GET", "/v1/kv/brief")[0], 404)

    def test_concurrency_and_restart_persistence(self) -> None:
        def write(index: int) -> int:
            return self.put(f"key-{index:02}", {"value": index})[0]

        with ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(write, range(24)))
        self.assertEqual(statuses, [201] * 24)
        self.stop_server()
        self.start_server()
        status, body, _ = self.request("GET", "/v1/keys")
        self.assertEqual(status, 200)
        assert body is not None
        self.assertEqual(body["keys"], [f"key-{index:02}" for index in range(24)])
        self.assertEqual(self.request("GET", "/v1/kv/key-17")[1]["value"], 17)  # type: ignore[index]

    def test_sigterm_closes_idle_keep_alive_connection(self) -> None:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("GET", "/health")
        self.assertEqual(connection.getresponse().read(), b'{"status":"ok"}')
        self.stop_server()
        connection.close()


if __name__ == "__main__":
    unittest.main()
