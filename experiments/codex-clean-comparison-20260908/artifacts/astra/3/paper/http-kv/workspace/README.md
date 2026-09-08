# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}` accepts `{"value": <JSON>, "ttl_seconds": <optional positive finite number>}` and returns 201 for a new key or 200 for replacement.
- `GET /v1/kv/{key}` returns `{"key": ..., "value": ...}`; missing or expired keys return 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys in URLs. Keys must be nonempty and cannot contain `/`.
Requests are limited to 1 MiB. Invalid requests return JSON errors. Chunked request
bodies are unsupported; send Content-Length. PUT rejects unknown fields.

Mutations are serialized and persisted using a flushed, fsynced temporary file
and atomic replacement in the data file's directory. TTL uses absolute wall-clock
expiry times, so it continues across restarts. Expired entries are filtered on
reads and startup and removed from disk on subsequent mutations. Use one server
process per data file. Malformed existing data files cause startup to fail.
SIGTERM and SIGINT stop accepting requests and wait for active handlers; idle
connections time out after five seconds.

Run the integration tests with `python3 -m unittest -v`.
