# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence and optional per-key TTLs.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./store.json
```

Using `--port 0` selects a free port. The first stdout line reports it as `LISTENING <port>`. Diagnostics are written to stderr. SIGINT and SIGTERM trigger a clean shutdown.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": <any JSON>, "ttl_seconds": <positive number>}`. The TTL is optional. Returns 201 when created and 200 when replaced.
- `GET /v1/kv/{url-encoded-key}` returns the key and value.
- `DELETE /v1/kv/{url-encoded-key}` deletes a live entry and returns 204.
- `GET /v1/keys` returns live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Keys must be non-empty UTF-8 strings and cannot contain `/`, including an encoded slash. Requests and responses use JSON, errors have an `error` field, and request bodies are limited to 1 MiB.

The data file is rewritten through a same-directory temporary file and atomic replacement after mutations and expired-entry cleanup. Its parent directory is created when needed.

## Quick check

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/greeting \
  -H 'Content-Type: application/json' \
  --data '{"value":"hello","ttl_seconds":60}'
curl -i http://127.0.0.1:8080/v1/kv/greeting
curl -i http://127.0.0.1:8080/v1/keys
```
