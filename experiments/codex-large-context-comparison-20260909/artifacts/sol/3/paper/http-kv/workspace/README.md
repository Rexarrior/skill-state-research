# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with atomic JSON-file persistence,
optional per-key expiration, and concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to choose a free port. The service prints its selected port as
`LISTENING <port>` on stdout; request diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": ..., "ttl_seconds": 60}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

All response bodies are JSON. Keys must be non-empty UTF-8 strings without `/`.
Request bodies are limited to 1 MiB, and TTL values must be finite positive
numbers.
