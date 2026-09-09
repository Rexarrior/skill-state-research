# Persistent HTTP key-value service

Requires Python 3.11+ and no dependencies. Start with:

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}` accepts `{"value": ...}` and optional positive, finite `ttl_seconds`; returns 201 for creation or 200 for replacement, with the key and value.
- `GET /v1/kv/{key}` returns the key and value, or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode keys as UTF-8; keys must be nonempty and cannot contain `/`. Bodies are limited to 1 MiB. Invalid requests return JSON errors. PUT requires a JSON object containing `value` and optionally `ttl_seconds`; unknown fields are rejected. Chunked request bodies are unsupported; use Content-Length.

Each mutation writes a complete snapshot through a flushed, fsynced temporary file and atomic replacement before responding. Absolute expiration timestamps survive restarts; expired entries are excluded from reads and snapshots. Replacing a value without TTL removes its previous TTL. A lock serializes storage operations across request threads. Use one server process per data file. Invalid data files cause startup to fail without overwriting them. SIGTERM/SIGINT stop acceptance, wait for request threads, and save live entries. Connections have a five-second I/O timeout.

Run integration tests with:

```sh
python3 -m unittest -v
```
