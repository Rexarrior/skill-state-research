# Persistent HTTP key-value service

This is a dependency-free Python 3.11+ HTTP service whose JSON values are saved
atomically to disk.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Passing `--port 0` selects a free port; the process prints `LISTENING <port>` as
its first stdout line. Diagnostics are written to stderr. Send `SIGTERM` or press
Ctrl-C for a clean shutdown.

## API

- `PUT /v1/kv/{url-encoded-key}` accepts `{"value": ..., "ttl_seconds": 30}`.
- `GET /v1/kv/{url-encoded-key}` reads a live value.
- `DELETE /v1/kv/{url-encoded-key}` deletes a live value.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` reports service health.

All request and response payloads are JSON. Request bodies are limited to 1 MiB.

Example:

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/hello%20world \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/hello%20world
```
