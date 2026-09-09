# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}` with JSON `{"value": ...}` creates (201) or replaces
  (200) an entry. Optional `ttl_seconds` must be a finite positive number.
- `GET /v1/kv/{key}` returns `{"key": ..., "value": ...}` or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` returns sorted live keys in `{"keys": [...]}`.
- `GET /health` returns `{"status":"ok"}`.

URL-encode UTF-8 keys; empty keys and keys containing `/` are rejected.
PUT requests require Content-Length and have a 1 MiB body limit. Chunked
requests are unsupported. Errors have a JSON `error` field.

Each successful mutation atomically replaces the JSON data file after flushing
it to disk. Concurrent requests are serialized around state access and writes.
Expiration uses absolute wall-clock timestamps, so TTL continues across restarts.
Expired entries are omitted from reads and removed from the next saved snapshot.
Use one server process per data file. Invalid existing data aborts startup.
SIGTERM or Ctrl-C stops accepting requests and waits for active handlers; idle
connections have a 10-second timeout.

Run the integration tests with `python3 -m unittest -v`.
