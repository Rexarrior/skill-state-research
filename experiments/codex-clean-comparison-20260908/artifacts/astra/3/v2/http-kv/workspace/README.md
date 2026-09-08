# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}`: JSON `{"value": ...}` with optional positive, finite
  `"ttl_seconds"`. Returns 201 for creation, 200 for replacement.
- `GET /v1/kv/{key}`: returns `{"key": ..., "value": ...}`, or 404.
- `DELETE /v1/kv/{key}`: returns 204 (empty body), or 404.
- `GET /v1/keys`: returns `{"keys": [...]}` sorted lexicographically.
- `GET /health`: returns `{"status":"ok"}`.

URL-encode keys as UTF-8; empty keys and slashes are rejected. Request bodies
are limited to 1 MiB and PUT requires Content-Length. Errors are JSON.

Writes atomically replace the JSON snapshot after flushing it to disk. Requests
are synchronized within one process; use only one server per data file. TTLs use
absolute wall-clock timestamps and remain in effect across restarts. Expired
entries are excluded from reads and removed from snapshots on store access or
startup. Corrupt data files cause startup to fail instead of silently losing data.
SIGTERM and Ctrl-C stop acceptance and wait for active requests; idle connections
have a 10-second timeout.

Run the integration tests with:

```sh
python3 -m unittest -v
```
