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
    def __init__(self, data_path):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline().strip()
        if not line.startswith("LISTENING "):
            raise RuntimeError(f"server failed to start: {line} {self.process.stderr.read()}")
        self.port = int(line.split()[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        payload = None if body is None else json.dumps(body)
        connection.request(method, path, body=payload, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        result = response.status, response.getheader("Content-Type"), (json.loads(raw) if raw else None)
        connection.close()
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=3)
        self.process.stdout.close()
        self.process.stderr.close()


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data_path = Path(self.temp.name) / "nested" / "store.json"
        self.server = RunningServer(self.data_path)

    def tearDown(self):
        self.server.close()
        self.temp.cleanup()

    def test_crud_keys_and_restart(self):
        key = quote("hello world")
        self.assertEqual(self.server.request("PUT", f"/v1/kv/{key}", {"value": {"n": 1}})[0], 201)
        self.assertEqual(self.server.request("PUT", f"/v1/kv/{key}", {"value": [2]})[0], 200)
        self.assertEqual(self.server.request("GET", f"/v1/kv/{key}")[2], {"key": "hello world", "value": [2]})
        self.assertEqual(self.server.request("GET", "/v1/keys")[2], {"keys": ["hello world"]})
        self.server.close()
        self.server = RunningServer(self.data_path)
        self.assertEqual(self.server.request("GET", f"/v1/kv/{key}")[0], 200)
        self.assertEqual(self.server.request("DELETE", f"/v1/kv/{key}")[0], 204)
        self.assertEqual(self.server.request("GET", f"/v1/kv/{key}")[0], 404)

    def test_ttl_and_validation(self):
        self.assertEqual(self.server.request("PUT", "/v1/kv/short", {"value": True, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.08)
        self.assertEqual(self.server.request("GET", "/v1/kv/short")[0], 404)
        for ttl in (0, -1, True, "1", None):
            self.assertEqual(self.server.request("PUT", "/v1/kv/bad", {"value": 1, "ttl_seconds": ttl})[0], 400)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.request("PUT", "/v1/kv/bad", body=b'{"value":1e400}')
        self.assertEqual(connection.getresponse().status, 400)
        connection.close()
        self.assertEqual(self.server.request("PUT", "/v1/kv/a%2Fb", {"value": 1})[0], 400)
        self.assertEqual(self.server.request("PUT", "/v1/kv/a%ZZ", {"value": 1})[0], 400)
        self.assertEqual(self.server.request("POST", "/health", {})[0], 405)
        self.assertEqual(self.server.request("GET", "/missing")[0], 404)

        connection = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=3)
        connection.putrequest("PUT", "/v1/kv/large")
        connection.putheader("Content-Length", str(1024 * 1024 + 1))
        connection.endheaders()
        self.assertEqual(connection.getresponse().status, 413)
        connection.close()

    def test_concurrent_writes(self):
        statuses = []
        def write(index):
            statuses.append(self.server.request("PUT", f"/v1/kv/k{index}", {"value": index})[0])
        threads = [threading.Thread(target=write, args=(index,)) for index in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 20)
        self.assertEqual(len(self.server.request("GET", "/v1/keys")[2]["keys"]), 20)
        with self.data_path.open(encoding="utf-8") as data_file:
            self.assertEqual(len(json.load(data_file)["entries"]), 20)


if __name__ == "__main__":
    unittest.main()
