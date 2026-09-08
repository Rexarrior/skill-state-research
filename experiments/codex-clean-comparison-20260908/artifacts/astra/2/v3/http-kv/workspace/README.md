# Persistent HTTP key-value service

Requires Python 3.11+ and no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
Use one server process per data file. SIGTERM or Ctrl-C stops accepting requests
and waits for active requests to finish (idle sockets time out after 10 seconds).

- `PUT /v1/kv/{key}` accepts `{"value": ANY, "ttl_seconds": NUMBER}`. TTL is
  optional, finite, and positive. Returns 201 for creation or 200 for replacement,
  with `{"key": KEY, "value": ANY}`. Replacement resets/removes the old TTL.
- `GET /v1/kv/{key}` returns the same object, or 404 when absent/expired.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` returns `{"keys": [...]}` sorted lexicographically.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys in URLs; keys must be nonempty and cannot contain `/`.
Bodies are UTF-8 JSON, limited to 1 MiB. Errors are JSON objects with an `error`
field. Chunked request bodies are unsupported; send Content-Length.

Changes are serialized under a lock and written using a flushed, fsynced temporary
file followed by atomic replacement. Expiration uses absolute wall-clock time
and survives restarts. Expired records are pruned on startup and store operations.
Invalid existing data causes startup to fail rather than silently discarding it.
The JSON file uses a versioned envelope with per-key values and expiration times.

Run integration tests with `python3 -m unittest -v`.
