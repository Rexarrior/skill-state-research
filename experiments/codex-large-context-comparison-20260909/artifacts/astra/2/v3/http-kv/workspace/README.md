# Persistent HTTP key-value service

Requires Python 3.11+; no third-party dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}` with `{"value": ANY, "ttl_seconds": NUMBER?}` creates (201) or replaces (200) an entry, returning its key and value.
- `GET /v1/kv/{key}` returns the key and value, or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` returns sorted live keys as `{"keys": [...]}`.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys. Keys must be nonempty and cannot contain `/`.
TTL must be a positive finite JSON number; omitting it makes the value permanent,
including when replacing an existing entry. Errors are JSON objects with an
`error` field. Request bodies are limited to 1 MiB; chunked uploads are unsupported.

Mutations are serialized and persisted before success is returned, using a flushed,
fsynced temporary file and atomic replacement. Expiration uses absolute wall-clock
timestamps and is checked on access and startup. SIGTERM/SIGINT stops the listener,
waits for active requests, and persists live entries. Use one server process per
data file. Invalid existing data causes startup to fail without overwriting it.

Run integration tests:

```sh
python3 -m unittest -v
```
