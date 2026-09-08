# Persistent HTTP key-value service

Requires Python 3.11+ and no third-party dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
Send SIGTERM or Ctrl-C to stop gracefully.

- `PUT /v1/kv/{key}`: JSON `{"value": ...}` with optional positive, finite
  `ttl_seconds`. Returns 201 on creation or 200 on replacement.
- `GET /v1/kv/{key}`: returns `{"key": ..., "value": ...}` or 404.
- `DELETE /v1/kv/{key}`: returns 204 (empty body) or 404.
- `GET /v1/keys`: returns sorted live keys in `{"keys": [...]}`.
- `GET /health`: returns `{"status":"ok"}`.

Percent-encode UTF-8 keys; empty keys and keys containing `/` are rejected.
PUT requires Content-Length and a JSON object containing `value` and optionally
`ttl_seconds`; other fields are rejected. Bodies are limited to 1 MiB.
Errors have JSON bodies. Chunked request encoding is not supported.

Mutations are synchronized and saved before success is returned, using a flushed,
fsynced temporary file and atomic replacement. Absolute expiration times survive
restarts. Expired entries are excluded from reads and subsequent snapshots.
Use one server process per data file. Invalid existing data causes startup to fail.
Connections have a five-second I/O timeout to bound shutdown waits.

Run integration tests with `python3 -m unittest -v`.
