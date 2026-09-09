# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <port>`. Diagnostics go to stderr.
Send SIGTERM or Ctrl-C to stop cleanly, waiting for active requests.

- `PUT /v1/kv/{key}` with `{"value": <JSON>, "ttl_seconds": 30}` creates
  (201) or replaces (200). Omit TTL for a permanent value. Replacing resets TTL.
- `GET /v1/kv/{key}` returns `{"key": "...", "value": ...}` or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys; empty keys and slashes are forbidden. TTLs must be
finite positive numbers. Request bodies are limited to 1 MiB. Errors are JSON.
PUT requires Content-Length; chunked transfer encoding is unsupported.

Writes use a lock and an fsynced temporary file followed by atomic replacement.
Expiration uses absolute wall-clock timestamps and survives restarts. Expired
entries are removed on access or startup. Run only one process per data file.
A corrupt data file causes startup to fail rather than discarding stored data.

Run integration tests with `python3 -m unittest -v`.
