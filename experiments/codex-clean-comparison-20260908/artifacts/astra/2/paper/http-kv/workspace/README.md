# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}` accepts `{"value": <any JSON>, "ttl_seconds": <optional positive finite number>}`; returns 201 on creation or 200 on replacement.
- `GET /v1/kv/{key}` returns `{"key": ..., "value": ...}`.
- `DELETE /v1/kv/{key}` returns 204 with no body.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys; empty keys and slashes are invalid. Missing or expired keys return 404. Errors are JSON. PUT requires Content-Length; bodies over 1 MiB and chunked encoding are rejected. Replacing a value without a TTL removes any prior expiration.

Writes are serialized and saved via a flushed, fsynced temporary file and atomic replacement before success is returned. Expiration uses absolute wall-clock timestamps and survives restart. Expired records are excluded when loading, reading, and writing; they may remain on disk until the next write. Use one server process per data file. SIGTERM and Ctrl-C stop acceptance and wait for active request threads; idle connections time out after 10 seconds.

Run the integration tests with `python3 -m unittest -v`.
