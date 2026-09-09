import http.client
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import quote


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "store.json"
        self.start()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(self.data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline()
        self.assertRegex(line, r"^LISTENING \d+\n$")
        self.port = int(line.split()[1])

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.assertEqual(self.process.returncode, 0)
        self.process.stdout.close()
        self.process.stderr.close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        encoded = None if body is None else json.dumps(body).encode()
        request_headers = {} if headers is None else dict(headers)
        if encoded is not None:
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, dict(response.getheaders()), json.loads(raw) if raw else None)
        connection.close()
        return result

    def test_crud_unicode_sorting_and_restart(self):
        key = "snow man ☃"
        status, _, result = self.request("PUT", "/v1/kv/" + quote(key), {"value": [1, None, True]})
        self.assertEqual(status, 201)
        self.assertEqual(result["value"], [1, None, True])
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 2})[0], 201)
        self.assertEqual(self.request("PUT", "/v1/kv/a", {"value": 3})[0], 200)
        self.assertEqual(self.request("GET", "/v1/keys")[2], {"keys": ["a", key]})
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/kv/a")[2], {"key": "a", "value": 3})
        self.assertEqual(self.request("DELETE", "/v1/kv/a")[0], 204)
        self.assertEqual(self.request("DELETE", "/v1/kv/a")[0], 404)

    def test_ttl_validation_and_expiration(self):
        for ttl in (0, -1, True):
            self.assertEqual(self.request("PUT", "/v1/kv/bad", {"value": 1, "ttl_seconds": ttl})[0], 400)
        self.assertEqual(self.request("PUT", "/v1/kv/short", {"value": 1, "ttl_seconds": 0.05})[0], 201)
        time.sleep(0.08)
        self.assertEqual(self.request("GET", "/v1/kv/short")[0], 404)
        self.stop()
        self.start()
        self.assertEqual(self.request("GET", "/v1/keys")[2], {"keys": []})

    def test_errors_and_limit(self):
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("POST", "/health")[0], 405)
        self.assertEqual(self.request("TRACE", "/health")[0], 405)
        self.assertEqual(self.request("GET", "/v1/kv/%2F")[0], 400)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("PUT", "/v1/kv/x", body=b"{")
        self.assertEqual(connection.getresponse().status, 400)
        connection.close()
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.putrequest("PUT", "/v1/kv/x")
        connection.putheader("Content-Length", str(1024 * 1024 + 1))
        connection.endheaders()
        self.assertEqual(connection.getresponse().status, 413)
        connection.close()

    def test_concurrent_writes(self):
        statuses = []
        lock = threading.Lock()

        def write(index):
            status = self.request("PUT", f"/v1/kv/k{index}", {"value": index})[0]
            with lock:
                statuses.append(status)

        threads = [threading.Thread(target=write, args=(index,)) for index in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [201] * 20)
        self.assertEqual(len(self.request("GET", "/v1/keys")[2]["keys"]), 20)


if __name__ == "__main__":
    unittest.main()
