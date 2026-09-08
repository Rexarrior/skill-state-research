# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}`: JSON `{"value": ...}` with optional positive, finite
  `"ttl_seconds"`. Returns 201 for creation or 200 for replacement.
- `GET /v1/kv/{key}`: returns `{"key": ..., "value": ...}`, or 404.
- `DELETE /v1/kv/{key}`: returns an empty 204 response, or 404.
- `GET /v1/keys`: returns sorted live keys as `{"keys": [...]}`.
- `GET /health`: returns `{"status":"ok"}`.

Percent-encode UTF-8 keys. Keys must be nonempty and cannot contain `/`.
Bodies are limited to 1 MiB. Errors have a JSON `error` field. PUT accepts
only `value` and `ttl_seconds`; null and boolean TTLs are invalid.

Updates are synchronized and written to a temporary file, flushed and fsynced,
then atomically replaced before success is returned. Expiration uses absolute
Unix timestamps and survives restarts. Replacing a value without a TTL removes
its previous expiration. SIGTERM/SIGINT stop accepting requests, finish active
requests, and persist live entries. Idle connections time out after 5 seconds.
Use one server process per data file. Invalid existing state fails startup
without overwriting the file.

Run integration tests with `python3 -m unittest -v`.
