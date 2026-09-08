# Persistent HTTP key-value service

Requires Python 3.11 or newer; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
Use SIGTERM or Ctrl-C to stop cleanly, allowing active requests to finish.

- `PUT /v1/kv/{key}` with `{"value": ANY, "ttl_seconds": 60}` creates (201)
  or replaces (200). Omit TTL for no expiration; replacement resets TTL.
- `GET /v1/kv/{key}` returns `{"key": KEY, "value": ANY}` or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode keys as UTF-8; keys must be nonempty and cannot contain `/`.
TTL must be a finite positive number. PUT accepts a JSON object containing
`value` and optional `ttl_seconds`. Errors are JSON. Request bodies are limited
to 1 MiB; chunked transfer encoding is unsupported.

Each mutation atomically replaces the JSON data file after flushing it to disk.
Expiration uses absolute wall-clock timestamps and survives restarts. Expired
records are pruned on startup and store access. Requests are serialized around
store operations; run only one server process per data file. Invalid persisted
state causes startup to fail rather than discard data. Socket operations time
out after five seconds so stalled clients cannot indefinitely block shutdown.

Run integration tests with `python3 -m unittest -v`.
