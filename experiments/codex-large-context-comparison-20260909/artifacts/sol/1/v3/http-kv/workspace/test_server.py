"""Black-box self-tests for server.py using only the standard library."""

from __future__ import annotations

import concurrent.futures
import http.client
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent


class RunningServer:
    def __init__(self, data_path: Path):
        self.data_path = data_path
        self.process: subprocess.Popen[str] | None = None
        self.port = 0

    def __enter__(self) -> "RunningServer":
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "server.py"),
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--data",
                str(self.data_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise RuntimeError(f"server failed to start: {line!r} {stderr}")
        self.port = int(line.split()[1])
        return self

    def __exit__(self, *args: object) -> None:
        assert self.process is not None
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()

    def request(self, method: str, path: str, body: object = None) -> tuple[int, object | None, dict[str, str]]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        headers: dict[str, str] = {}
        encoded = None
        if body is not None:
            encoded = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=encoded, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        connection.close()
        return response.status, json.loads(raw) if raw else None, response_headers


class ServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.data_path = Path(self.temporary.name) / "nested" / "store.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_crud_keys_errors_and_ttl(self) -> None:
        with RunningServer(self.data_path) as server:
            status, body, headers = server.request("GET", "/health")
            self.assertEqual((status, body), (200, {"status": "ok"}))
            self.assertEqual(headers["content-type"], "application/json")

            key = "snow man ☃"
            path = "/v1/kv/" + quote(key, safe="")
            self.assertEqual(server.request("PUT", path, {"value": {"n": 1}})[0], 201)
            self.assertEqual(server.request("PUT", path, {"value": [1, None]})[0], 200)
            self.assertEqual(
                server.request("GET", path)[:2],
                (200, {"key": key, "value": [1, None]}),
            )
            self.assertEqual(server.request("GET", "/v1/keys")[1], {"keys": [key]})
            self.assertEqual(server.request("DELETE", path)[:2], (204, None))
            self.assertEqual(server.request("DELETE", path)[0], 404)

            self.assertEqual(server.request("GET", "/missing")[0], 404)
            self.assertEqual(server.request("POST", "/health", {})[0], 405)
            self.assertEqual(server.request("GET", "/v1/kv/a%2Fb")[0], 400)
            for ttl in (0, -1, True, "1"):
                self.assertEqual(
                    server.request("PUT", "/v1/kv/bad", {"value": 1, "ttl_seconds": ttl})[0],
                    400,
                )

            self.assertEqual(
                server.request("PUT", "/v1/kv/short", {"value": 2, "ttl_seconds": 0.08})[0],
                201,
            )
            time.sleep(0.12)
            self.assertEqual(server.request("GET", "/v1/kv/short")[0], 404)
            self.assertEqual(server.request("GET", "/v1/keys")[1], {"keys": []})

    def test_body_limit_malformed_json_and_shape(self) -> None:
        with RunningServer(self.data_path) as server:
            connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=3)
            connection.request("PUT", "/v1/kv/x", body=b"{")
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertIsInstance(json.loads(response.read()), dict)
            connection.close()

            self.assertEqual(server.request("PUT", "/v1/kv/x", [1, 2])[0], 400)
            self.assertEqual(server.request("PUT", "/v1/kv/x", {"ttl_seconds": 1})[0], 400)

            connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=3)
            # The server can reject an oversized declared body immediately;
            # avoid continuing to upload bytes after that response.
            connection.putrequest("PUT", "/v1/kv/x")
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Content-Length", str(1024 * 1024 + 1))
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
            json.loads(response.read())
            connection.close()

    def test_restart_and_concurrent_requests(self) -> None:
        with RunningServer(self.data_path) as server:
            self.assertEqual(server.request("PUT", "/v1/kv/keep", {"value": "yes"})[0], 201)
            self.assertEqual(
                server.request("PUT", "/v1/kv/expire", {"value": "no", "ttl_seconds": 0.05})[0],
                201,
            )

            def put(index: int) -> int:
                return server.request("PUT", f"/v1/kv/k{index:02d}", {"value": index})[0]

            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
                statuses = list(executor.map(put, range(24)))
            self.assertEqual(statuses, [201] * 24)
            time.sleep(0.08)

        self.assertTrue(self.data_path.exists())
        with RunningServer(self.data_path) as restarted:
            self.assertEqual(restarted.request("GET", "/v1/kv/keep")[1]["value"], "yes")
            self.assertEqual(restarted.request("GET", "/v1/kv/expire")[0], 404)
            keys = restarted.request("GET", "/v1/keys")[1]["keys"]
            self.assertEqual(keys, sorted(["keep"] + [f"k{i:02d}" for i in range(24)]))


if __name__ == "__main__":
    unittest.main()
