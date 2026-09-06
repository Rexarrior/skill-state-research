import json
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def request(port, method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


with tempfile.TemporaryDirectory() as directory:
    data_path = Path(directory) / "data.json"
    proc = subprocess.Popen([sys.executable, "server.py", "--host", "127.0.0.1", "--port", "0", "--data", str(data_path)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    port = int(proc.stdout.readline().split()[1])
    assert request(port, "GET", "/health")[0] == 200
    key = urllib.parse.quote("hello world")
    assert request(port, "PUT", f"/v1/kv/{key}", {"value": [1, 2]})[0] == 201
    assert request(port, "PUT", f"/v1/kv/{key}", {"value": 3})[0] == 200
    status, body = request(port, "GET", f"/v1/kv/{key}")
    assert status == 200 and json.loads(body)["value"] == 3
    assert json.loads(request(port, "GET", "/v1/keys")[1])["keys"] == ["hello world"]
    assert request(port, "PUT", "/v1/kv/temp", {"value": 1, "ttl_seconds": 0.05})[0] == 201
    time.sleep(0.1)
    assert request(port, "GET", "/v1/kv/temp")[0] == 404
    assert request(port, "PUT", "/v1/kv/bad", {"value": 1, "ttl_seconds": 0})[0] == 400
    assert request(port, "PUT", "/v1/kv/bad", [1])[0] == 400
    assert request(port, "DELETE", f"/v1/kv/{key}")[0] == 204
    proc.terminate()
    proc.wait(timeout=5)
print("self-tests passed")
