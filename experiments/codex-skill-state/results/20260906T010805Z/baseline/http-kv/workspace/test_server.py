"""Dependency-free integration tests for server.py."""

from __future__ import annotations

import http.client
import json
import signal
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
    def __init__(self, data_path: Path) -> None:
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "server.py"),
                "--host", "127.0.0.1",
                "--port", "0",
                "--data", str(data_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            self.process.wait(timeout=5)
            assert self.process.stderr is not None
            diagnostic = self.process.stderr.read().strip()
            self.process.stdout.close()
            self.process.stderr.close()
            raise RuntimeError(f"server did not start: {line!r} ({diagnostic})")
        self.port = int(line.split()[1])

    def request(
        self,
        method: str,
        path: str,
        body: object | bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], object | None]:
        request_headers = dict(headers or {})
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body, separators=(",", ":")).encode()
            request_headers.setdefault("Content-Type", "application/json")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        payload = response.read()
        result = json.loads(payload) if payload else None
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        connection.close()
        return response.status, response_headers, result

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()


class ServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.data_path = Path(self.temporary_directory.name) / "nested" / "data.json"
        self.server = RunningServer(self.data_path)

    def tearDown(self) -> None:
        self.server.stop()
        self.temporary_directory.cleanup()

    def test_crud_sorting_and_persistence(self) -> None:
        key = "a spaced key"
        encoded = quote(key, safe="")
        status, headers, body = self.server.request(
            "PUT", f"/v1/kv/{encoded}", {"value": {"nested": [1, None, True]}}
        )
        self.assertEqual(201, status)
        self.assertEqual("application/json", headers["content-type"])
        self.assertEqual(key, body["key"])

        status, _, _ = self.server.request("PUT", "/v1/kv/z", {"value": 2})
        self.assertEqual(201, status)
        status, _, _ = self.server.request("PUT", f"/v1/kv/{encoded}", {"value": 3})
        self.assertEqual(200, status)
        status, _, body = self.server.request("GET", "/v1/keys")
        self.assertEqual(200, status)
        self.assertEqual([key, "z"], body["keys"])

        self.server.stop()
        self.server = RunningServer(self.data_path)
        status, _, body = self.server.request("GET", f"/v1/kv/{encoded}")
        self.assertEqual(200, status)
        self.assertEqual(3, body["value"])
        status, _, body = self.server.request("DELETE", f"/v1/kv/{encoded}")
        self.assertEqual(204, status)
        self.assertIsNone(body)
        self.assertEqual(404, self.server.request("GET", f"/v1/kv/{encoded}")[0])

    def test_ttl_validation_and_expiry_across_restart(self) -> None:
        for ttl in (0, -1, True, "1", None):
            request = {"value": 1, "ttl_seconds": ttl}
            status, _, _ = self.server.request("PUT", "/v1/kv/ttl", request)
            self.assertEqual(400, status)

        self.assertEqual(
            201,
            self.server.request(
                "PUT", "/v1/kv/short", {"value": "gone", "ttl_seconds": 0.08}
            )[0],
        )
        time.sleep(0.12)
        self.server.stop()
        self.server = RunningServer(self.data_path)
        self.assertEqual(404, self.server.request("GET", "/v1/kv/short")[0])
        self.assertEqual([], self.server.request("GET", "/v1/keys")[2]["keys"])

    def test_errors_and_body_limit(self) -> None:
        cases = [
            ("PUT", "/v1/kv/x", b"{", {}, 400),
            ("PUT", "/v1/kv/x", [], {}, 400),
            ("PUT", "/v1/kv/x", {"other": 1}, {}, 400),
            ("PUT", "/v1/kv/", {"value": 1}, {}, 400),
            ("GET", "/v1/kv/a%2Fb", None, {}, 400),
            ("GET", "/missing", None, {}, 404),
            ("POST", "/health", None, {}, 405),
            ("BREW", "/health", None, {}, 405),
        ]
        for method, path, body, headers, expected in cases:
            with self.subTest(method=method, path=path, body=body):
                status, response_headers, response_body = self.server.request(
                    method, path, body, headers
                )
                self.assertEqual(expected, status)
                self.assertEqual("application/json", response_headers["content-type"])
                self.assertIn("error", response_body)

        oversized = b'"' + b"a" * (1024 * 1024) + b'"'
        self.assertEqual(
            413,
            self.server.request("PUT", "/v1/kv/large", oversized)[0],
        )

    def test_concurrent_writes_remain_valid(self) -> None:
        statuses: list[int] = []
        status_lock = threading.Lock()

        def write(index: int) -> None:
            status, _, _ = self.server.request(
                "PUT", f"/v1/kv/k{index:02d}", {"value": index}
            )
            with status_lock:
                statuses.append(status)

        threads = [threading.Thread(target=write, args=(index,)) for index in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual([201] * 20, sorted(statuses))
        with self.data_path.open(encoding="utf-8") as source:
            persisted = json.load(source)
        self.assertEqual(20, len(persisted["entries"]))

    def test_health(self) -> None:
        status, _, body = self.server.request("GET", "/health")
        self.assertEqual(200, status)
        self.assertEqual({"status": "ok"}, body)


if __name__ == "__main__":
    unittest.main()
