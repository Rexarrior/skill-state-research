# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}`: JSON object with required `value` (any JSON value) and optional positive, finite `ttl_seconds`. Returns 201 on creation, 200 on replacement, with the key and value.
- `GET /v1/kv/{key}`: returns the key and value, or 404.
- `DELETE /v1/kv/{key}`: returns 204 with no body, or 404.
- `GET /v1/keys`: returns live keys in lexicographic order.
- `GET /health`: returns `{"status":"ok"}`.

Percent-encode keys as UTF-8; spaces are allowed, empty keys and slashes are not. Errors are JSON. Request bodies are limited to 1 MiB. PUT requires Content-Length; chunked transfer is unsupported. Replacing a value without a TTL removes its previous expiration.

Writes are serialized and persisted through a flushed, fsynced temporary file and atomic replacement before success is returned. Absolute expiration times survive restarts. Expired entries are filtered on access, startup, writes, and shutdown. Use one server process per data file. Invalid persistence files cause startup to fail rather than discard data. SIGTERM/SIGINT stop acceptance, wait for active requests, and persist live entries; idle connections time out after five seconds.

Run integration tests with:

```sh
python3 -m unittest -v
```
