# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON API backed by an atomically replaced JSON file.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select a free port; the service prints `LISTENING <port>` to stdout. Diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": ..., "ttl_seconds": 60}` creates (201) or replaces (200) a value. TTL is optional.
- `GET /v1/kv/{url-encoded-key}` fetches a live value.
- `DELETE /v1/kv/{url-encoded-key}` deletes a live value (204).
- `GET /v1/keys` lists live keys in lexical order.
- `GET /health` returns service health.

All response bodies are JSON. Request bodies are limited to 1 MiB. Send `SIGTERM` or press Ctrl-C for a clean shutdown.
