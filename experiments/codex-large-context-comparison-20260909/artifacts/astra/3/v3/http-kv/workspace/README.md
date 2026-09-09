# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}` with `{"value": ANY, "ttl_seconds": NUMBER}` stores JSON. TTL is optional, finite, and positive; omission removes any previous expiry. Returns 201 on creation or 200 on replacement, with the key and value.
- `GET /v1/kv/{key}` returns `{"key": KEY, "value": ANY}` or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode keys as UTF-8. Keys must be nonempty and cannot contain `/`. Bodies are limited to 1 MiB. Invalid requests receive JSON errors. Chunked request bodies are unsupported; send Content-Length. Connections close after each response.

Mutations are serialized and persisted before success using a flushed, fsynced temporary file and atomic replacement. Expiration uses absolute wall-clock timestamps and survives restarts. Expired records are pruned during storage operations, startup, and clean shutdown. SIGTERM/SIGINT stop accepting requests and wait for active handlers (socket inactivity timeout: 10 seconds). Use one service process per data file; concurrent processes sharing a file are unsupported. Invalid existing data causes startup to fail rather than discard it.

Run the integration tests:

```sh
python3 -m unittest -v
```
