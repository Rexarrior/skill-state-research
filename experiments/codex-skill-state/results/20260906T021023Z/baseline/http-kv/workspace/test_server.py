from __future__ import annotations

import http.client
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import quote


class RunningServer:
    def __init__(self, data_path: Path) -> None:
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
        assert self.process.stdout is not None
        first_line = self.process.stdout.readline().strip()
        if not first_line.startswith("LISTENING "):
            stderr = self.process.stderr.read() if self.process.stderr else ""
            self.process.wait(timeout=5)
            self.process.stdout.close()
            if self.process.stderr:
                self.process.stderr.close()
            raise RuntimeError(f"server failed to start: {first_line!r} {stderr}")
        self.port = int(first_line.split()[1])

    def request(self, method: str, path: str, body: object = ...) -> tuple[int, object]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        headers: dict[str, str] = {}
        encoded = None
        if body is not ...:
            encoded = json.dumps(body, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=encoded, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        self.content_type = response.getheader("Content-Type")
        connection.close()
        return response.status, json.loads(raw) if raw else None

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

    def test_crud_sorting_and_encoded_key(self) -> None:
        key = quote("space key", safe="")
        status, body = self.server.request("PUT", f"/v1/kv/{key}", {"value": [1, None]})
        self.assertEqual((status, body), (201, {"key": "space key", "value": [1, None]}))
        self.assertEqual(self.server.content_type, "application/json")
        self.assertEqual(self.server.request("PUT", "/v1/kv/alpha", {"value": 2})[0], 201)
        self.assertEqual(self.server.request("PUT", f"/v1/kv/{key}", {"value": 3})[0], 200)
        self.assertEqual(
            self.server.request("GET", "/v1/keys"),
            (200, {"keys": ["alpha", "space key"]}),
        )
        self.assertEqual(
            self.server.request("GET", f"/v1/kv/{key}"),
            (200, {"key": "space key", "value": 3}),
        )
        self.assertEqual(self.server.request("DELETE", f"/v1/kv/{key}"), (204, None))
        self.assertEqual(self.server.request("GET", f"/v1/kv/{key}")[0], 404)

    def test_ttl_and_restart_persistence(self) -> None:
        self.assertEqual(
            self.server.request("PUT", "/v1/kv/live", {"value": "kept"})[0], 201
        )
        self.assertEqual(
            self.server.request(
                "PUT", "/v1/kv/short", {"value": "gone", "ttl_seconds": 0.1}
            )[0],
            201,
        )
        time.sleep(0.15)
        self.server.stop()
        self.server = RunningServer(self.data_path)
        self.assertEqual(
            self.server.request("GET", "/v1/kv/live"),
            (200, {"key": "live", "value": "kept"}),
        )
        self.assertEqual(self.server.request("GET", "/v1/kv/short")[0], 404)
        persisted = json.loads(self.data_path.read_text())
        self.assertNotIn("short", persisted["entries"])

    def test_validation_and_limits(self) -> None:
        self.assertEqual(self.server.request("GET", "/missing")[0], 404)
        self.assertEqual(self.server.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.server.request("BREW", "/health")[0], 405)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a", ["wrong"])[0], 400)
        self.assertEqual(
            self.server.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": 0})[0],
            400,
        )
        self.assertEqual(
            self.server.request("PUT", "/v1/kv/a", {"value": 1, "ttl_seconds": None})[0],
            400,
        )
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request(
            "PUT", "/v1/kv/large", body=b"{}", headers={"Content-Length": str(1024 * 1024 + 1)}
        )
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        connection.close()

        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request(
            "PUT",
            "/v1/kv/bad-json",
            body=b'{"value":NaN}',
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        response.read()
        connection.close()

    def test_concurrent_writes_are_all_durable(self) -> None:
        errors: list[BaseException] = []

        def write(index: int) -> None:
            try:
                status, _ = self.server.request(
                    "PUT", f"/v1/kv/k{index:02d}", {"value": index}
                )
                self.assertEqual(status, 201)
            except BaseException as exc:
                errors.append(exc)

        threads = [threading.Thread(target=write, args=(index,)) for index in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.server.stop()
        self.server = RunningServer(self.data_path)
        status, body = self.server.request("GET", "/v1/keys")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"keys": [f"k{index:02d}" for index in range(20)]})


if __name__ == "__main__":
    unittest.main()
