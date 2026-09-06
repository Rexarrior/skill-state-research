# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON API with TTL support and atomic on-disk
persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Passing `--port 0` selects a free port; the service prints
`LISTENING <actual-port>` as its first stdout line. Diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": ..., "ttl_seconds": 60}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Keys are UTF-8, may contain spaces, and may not contain `/`. `ttl_seconds` is
optional and must be a finite positive number. Request bodies are limited to
1 MiB. The data file is replaced atomically after mutations, so live values
survive restarts while expired values are discarded.

Example:

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/hello%20world \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42}}'
curl -i http://127.0.0.1:8080/v1/kv/hello%20world
```
