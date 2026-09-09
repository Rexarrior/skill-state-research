# Persistent HTTP key-value service

Requires Python 3.11+; no external dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
Replace `0` with a fixed port if desired. Stop with SIGTERM or Ctrl-C; active
requests finish before exit.

- `PUT /v1/kv/{key}` accepts `{"value": ANY, "ttl_seconds": NUMBER}`.
  TTL is optional, finite, and positive. Returns 201 on creation, 200 on replacement.
- `GET /v1/kv/{key}` returns `{"key": KEY, "value": ANY}` or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` returns `{"keys": [...]}` in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys in URLs. Empty keys and keys containing `/` are invalid.
PUT bodies must be JSON objects with `value` and optionally `ttl_seconds`;
unknown fields are rejected. Bodies are limited to 1 MiB. Send Content-Length;
chunked requests are unsupported. Errors have a JSON `error` field.

Updates serialize under a lock and atomically replace an fsynced JSON snapshot.
Expiration uses absolute wall-clock timestamps, survives restarts, and is checked
on every access. Expired records are removed from snapshots on the next mutation
or startup. A replacement without TTL clears the prior TTL. Use one server process
per data file; cross-process locking is not provided. Invalid data files fail startup.

Run integration tests:

```sh
python3 -m unittest -v
```
