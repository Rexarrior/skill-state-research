# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service that stores JSON values, supports
optional TTLs, and persists live entries with atomic file replacement.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Passing `--port 0` selects an available port and prints
`LISTENING <actual-port>` as the first stdout line. Diagnostics are written to
stderr. Stop the service with `SIGTERM` or `Ctrl-C` for a clean shutdown.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": <json>, "ttl_seconds": <positive finite number>}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

All request and response bodies are JSON, except successful `DELETE`, which
returns HTTP 204 with no body. Request bodies are limited to 1 MiB. Keys must
be non-empty UTF-8 strings without `/`; spaces should be URL-encoded. Expired
entries are removed and are not restored after restart.

## Quick check

```sh
python3 server.py --port 8080 --data /tmp/kv-data.json
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl -i http://127.0.0.1:8080/v1/kv/example
curl -i http://127.0.0.1:8080/v1/keys
```
