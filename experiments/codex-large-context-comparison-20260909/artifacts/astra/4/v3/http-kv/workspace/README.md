# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
The data file's parent directory must exist. Use one server process per data file.
SIGTERM and Ctrl-C stop accepting requests and wait for active handlers.

- `PUT /v1/kv/{key}`: JSON `{"value": ...}` with optional positive, finite
  `"ttl_seconds"`; returns 201 on creation, 200 on replacement, and the key/value.
- `GET /v1/kv/{key}`: returns `{"key": ..., "value": ...}` or 404.
- `DELETE /v1/kv/{key}`: returns 204 with no body, or 404.
- `GET /v1/keys`: returns `{"keys": [...]}` sorted lexicographically.
- `GET /health`: returns `{"status":"ok"}`.

Percent-encode keys as UTF-8. Keys must be nonempty and cannot contain `/`.
Errors are JSON objects with an `error` field. Bodies are limited to 1 MiB;
PUT requires Content-Length (chunked transfer encoding is unsupported).
JSON numbers must be finite. Unknown PUT fields are rejected.

Mutations are serialized and persisted with a flushed, fsynced temporary file
and atomic replacement before success is returned. Values and absolute expiration
timestamps survive restarts. Expired entries are filtered on reads and startup,
and omitted from subsequent writes. Replacing a value without a TTL removes its
previous expiration. A malformed existing data file causes startup to fail.

Run integration tests:

```sh
python3 -m unittest discover -v
```
