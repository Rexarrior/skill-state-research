# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with TTL support and atomic file persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints only `LISTENING <port>` to stdout; request diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": ..., "ttl_seconds": 30}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Keys must be non-empty UTF-8 strings without `/`. `ttl_seconds` is optional and must be a finite positive number. Request bodies are limited to 1 MiB. All response bodies are JSON.

## Test

```sh
python3 -m unittest -v
```
