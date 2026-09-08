# Persistent HTTP key-value service

Requires Python 3.11 or newer; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}` with `{"value": <any JSON>, "ttl_seconds": <optional positive number>}` creates (201) or replaces (200) an entry. Replacement resets/removes the previous TTL.
- `GET /v1/kv/{key}` returns `{"key": ..., "value": ...}` or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys; empty keys and slashes are rejected. Errors are JSON. PUT bodies must be JSON objects containing `value` and optionally `ttl_seconds`; bodies are limited to 1 MiB. Chunked request bodies are unsupported.

Writes are serialized and saved using a flushed, fsynced temporary file followed by atomic replacement. Expiration uses absolute wall-clock timestamps and survives restarts. Expired entries are removed on store access and startup. Use one server process per data file. Invalid data files cause startup to fail rather than overwrite data. SIGTERM and SIGINT stop accepting requests and wait for active handlers (idle connections time out after 10 seconds).

Run self-tests with `python3 -m unittest -v`.
