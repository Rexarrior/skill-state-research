# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
The data file's parent directory must exist. Stop with SIGTERM or Ctrl-C;
active requests finish before exit.

- `PUT /v1/kv/{key}`: JSON object with required `value` (any JSON value) and
  optional positive finite numeric `ttl_seconds`. Returns 201 on creation,
  200 on replacement, and the stored key/value. Replacement resets the TTL;
  omitting TTL makes the value persistent.
- `GET /v1/kv/{key}`: returns `{"key": KEY, "value": VALUE}` or 404.
- `DELETE /v1/kv/{key}`: returns 204 with no body, or 404.
- `GET /v1/keys`: returns `{"keys": [...]}` in lexicographic order.
- `GET /health`: returns `{"status":"ok"}`.

Percent-encode keys as UTF-8; spaces are allowed, empty keys and slashes are
rejected. Errors are JSON objects with an `error` string. Request bodies are
limited to 1 MiB and require Content-Length; chunked uploads are unsupported.

Mutations atomically replace the JSON data file after flushing it to disk.
Concurrent requests are serialized around store access. Expiration uses absolute
wall-clock timestamps, survives restarts, and is cleaned up on startup and store
access. Use one server process per data file; sharing a file between processes
is unsupported. The service provides no authentication or TLS.

Run integration tests:

```sh
python3 -m unittest -v
```
