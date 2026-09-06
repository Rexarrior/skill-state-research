# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence, optional TTLs, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port; the service prints `LISTENING <port>` as its first stdout line. Diagnostics go to stderr. Stop it with `SIGTERM` or `Ctrl-C`.

## API

- `PUT /v1/kv/{url-encoded-key}` — JSON body `{"value": ..., "ttl_seconds": 30}`; TTL is optional.
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Request bodies are limited to 1 MiB. Keys must be non-empty UTF-8 strings without `/`.

## Test

```sh
python3 -m unittest -v
```
