# Persistent HTTP key-value service

Requires Python 3.11 or newer; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}` with `{"value": ANY, "ttl_seconds": NUMBER}` stores a value (201 for new, 200 for replacement). TTL is optional, finite, and positive.
- `GET /v1/kv/{key}` returns the key and value, or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` lists live keys in sorted order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys; empty keys and slashes are rejected. Requests use strict JSON, and PUT bodies are limited to 1 MiB. Requests require Content-Length; chunked transfer encoding is unsupported. Errors have JSON bodies. HEAD responses have no body as required by HTTP.

Mutations are serialized and persisted before success using a flushed, fsynced temporary file and atomic replacement in the data directory. Expiry timestamps use wall-clock time and survive restarts. Expired entries are filtered from every operation and pruned from disk on startup or the next mutation. Run only one server process per data file. Invalid persistence files cause startup to fail without overwriting them. SIGTERM and SIGINT stop accepting requests and wait for active requests (socket inactivity timeout: 10 seconds).

Run the integration tests:

```sh
python3 -m unittest discover -v
```
