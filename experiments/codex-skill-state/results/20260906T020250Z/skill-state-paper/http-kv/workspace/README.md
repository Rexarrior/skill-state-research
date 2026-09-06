# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with TTL support and atomic
on-disk persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port; the service prints
`LISTENING <actual-port>` as its first stdout line. Diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": ..., "ttl_seconds": 30}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

`ttl_seconds` is optional. Keys may contain spaces (encode them as `%20`) but
not slashes. Requests and non-empty responses use JSON, and request bodies are
limited to 1 MiB.

## Quick check

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' -d '{"value":{"answer":42}}'
curl -i http://127.0.0.1:8080/v1/kv/example
curl -i http://127.0.0.1:8080/v1/keys
```

Stop the process with `SIGTERM` or `Ctrl-C`; acknowledged updates are already
persisted synchronously, and shutdown waits for active requests.
