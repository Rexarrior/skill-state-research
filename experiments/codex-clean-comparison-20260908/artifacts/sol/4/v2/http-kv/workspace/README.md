# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence,
optional TTLs, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select an available port; the service prints
`LISTENING <actual-port>` as its first stdout line. Diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": ..., "ttl_seconds": 30}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Requests and non-empty responses use JSON. Keys must be non-empty UTF-8 strings
without `/`; values may be any JSON value. Request bodies are limited to 1 MiB.
The data file is replaced atomically after changes.

## Test

```sh
python3 -m unittest -v
```
