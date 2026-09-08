# Persistent HTTP key-value service

Requires Python 3.11+, with no third-party dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
Use one server process per data file. SIGTERM and Ctrl-C stop the server cleanly.

- `PUT /v1/kv/{key}` with `{"value": <any JSON>, "ttl_seconds": <optional positive number>}` creates (201) or replaces (200) an entry. Replacement resets expiration; omitting TTL makes it permanent.
- `GET /v1/kv/{key}` returns `{"key": ..., "value": ...}` or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` returns sorted live keys in `{"keys": [...]}`.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode keys as UTF-8. Keys must be nonempty and cannot contain `/`.
Requests are limited to 1 MiB and PUT bodies must be JSON objects containing
`value` and optionally `ttl_seconds`. Errors are JSON objects with an `error`
message. Chunked request bodies are unsupported; send `Content-Length`.

Updates are serialized and persisted before success is returned. Snapshots use
a flushed, fsynced temporary file in the data directory and atomic replacement.
Expiration uses absolute Unix timestamps and continues across restarts. Expired
entries are removed on store access, startup, and graceful shutdown. Invalid
persistence files cause startup to fail instead of discarding data.

Run the integration tests:

```sh
python3 -m unittest -v
```
