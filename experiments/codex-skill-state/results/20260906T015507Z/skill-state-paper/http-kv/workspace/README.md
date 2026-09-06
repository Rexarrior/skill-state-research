# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence,
optional per-key TTLs, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./store.json
```

Use `--port 0` to choose a free port. The process prints `LISTENING <port>` to
stdout when ready; request diagnostics go to stderr. SIGTERM and Ctrl-C perform
a clean shutdown.

## API

- `PUT /v1/kv/{url-encoded-key}` — JSON body `{"value": ..., "ttl_seconds": 60}`;
  `ttl_seconds` is optional. Returns 201 on creation and 200 on replacement.
- `GET /v1/kv/{url-encoded-key}` — fetch a live entry.
- `DELETE /v1/kv/{url-encoded-key}` — delete an entry (204), or return 404.
- `GET /v1/keys` — list live keys in lexicographic order.
- `GET /health` — health check.

Keys must be non-empty UTF-8 strings and may contain spaces but not `/`. Bodies
larger than 1 MiB are rejected. All errors are JSON objects with an `error`
field. The data file is replaced atomically after every mutation and expired
records are removed rather than restored after restart.

Example:

```sh
curl -i -X PUT 'http://127.0.0.1:8080/v1/kv/my%20key' \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":300}'
curl -i 'http://127.0.0.1:8080/v1/kv/my%20key'
```
