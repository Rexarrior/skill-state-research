# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON API with atomic disk persistence and optional TTLs.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to choose a free port. The service prints `LISTENING <port>` to stdout when ready; request logs and startup errors go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": <JSON>, "ttl_seconds": <positive number>}` creates (201) or replaces (200) an entry. The TTL is optional.
- `GET /v1/kv/{url-encoded-key}` returns the live entry or 404.
- `DELETE /v1/kv/{url-encoded-key}` removes an entry (204) or returns 404.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Keys are UTF-8, non-empty, and cannot contain `/`. Request bodies are limited to 1 MiB. Every response uses JSON content type; errors have the form `{"error":"..."}`.

Example:

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/my%20key \
  -H 'Content-Type: application/json' \
  --data '{"value":{"enabled":true},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/my%20key
```
