# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
The data file's parent directory must exist. Use one server process per file.
SIGTERM and Ctrl-C stop the listener, finish active requests, and save live state.

- `PUT /v1/kv/{key}`: JSON object with required `value` (any JSON value) and
  optional positive finite `ttl_seconds`. Returns 201 on creation, 200 on replacement.
- `GET /v1/kv/{key}`: returns `{"key": KEY, "value": VALUE}`, or 404.
- `DELETE /v1/kv/{key}`: returns 204 with no body, or 404.
- `GET /v1/keys`: returns live keys in lexicographic order.
- `GET /health`: returns `{"status":"ok"}`.

Percent-encode keys as UTF-8; keys must be nonempty and cannot contain `/`.
PUT requires Content-Length and permits at most 1 MiB. Unknown fields and invalid
JSON are rejected. Errors use JSON with an `error` field. Chunked requests are
unsupported. Connections close after each response; idle reads time out after
five seconds.

Writes are serialized and persisted by flushing a temporary file and atomically
replacing the data file before acknowledging success. Expiration uses absolute
wall-clock timestamps and survives restarts. Expired records are filtered on
reads and removed from disk on subsequent writes, startup, and clean shutdown.
Replacing a value without a TTL removes any previous expiration.

Run integration tests:

```sh
python3 -m unittest -v
```
