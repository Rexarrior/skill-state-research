# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service that stores arbitrary JSON values and persists live entries with atomic file replacement.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Using `--port 0` selects a free port; the service prints `LISTENING <port>` as its first stdout line. Diagnostics are written to stderr. Stop the service with `SIGTERM` or Ctrl-C.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": <any JSON>, "ttl_seconds": <optional positive finite number>}` creates (`201`) or replaces (`200`) an entry.
- `GET /v1/kv/{url-encoded-key}` returns the live entry or `404`.
- `DELETE /v1/kv/{url-encoded-key}` removes a live entry (`204`) or returns `404`.
- `GET /v1/keys` returns live keys in lexicographic order.
- `GET /health` returns service health.

Keys must be nonempty UTF-8, may contain spaces, and may not contain `/`. All request and nonempty response bodies are JSON. Request bodies are limited to 1 MiB.

Example:

```sh
curl -i -X PUT 'http://127.0.0.1:8080/v1/kv/my%20key' \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl 'http://127.0.0.1:8080/v1/kv/my%20key'
curl 'http://127.0.0.1:8080/v1/keys'
```

## Self-check

```sh
python3 -m py_compile server.py
```

