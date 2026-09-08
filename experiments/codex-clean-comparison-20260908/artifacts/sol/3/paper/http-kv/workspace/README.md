# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence,
optional per-key TTLs, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./store.json
```

Port `0` selects a free port; the service prints `LISTENING <port>` to stdout when
ready. Diagnostics are written to stderr. Send SIGTERM or press Ctrl-C for a clean
shutdown.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": ..., "ttl_seconds": 30}` creates
  (201) or replaces (200) a value. `ttl_seconds` is optional.
- `GET /v1/kv/{url-encoded-key}` retrieves a live value.
- `DELETE /v1/kv/{url-encoded-key}` deletes a live value (204).
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns service health.

All response bodies are JSON. Request bodies are limited to 1 MiB.

Example:

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/greeting \
  -H 'Content-Type: application/json' \
  --data '{"value":"hello"}'
curl http://127.0.0.1:8080/v1/kv/greeting
```
