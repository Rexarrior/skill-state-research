# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with TTL support and atomic
on-disk persistence.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select a free port. The service prints `LISTENING <port>` as
its first stdout line; request diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` — JSON body `{"value": ..., "ttl_seconds": 60}`;
  the TTL is optional. Returns 201 when created and 200 when replaced.
- `GET /v1/kv/{url-encoded-key}` — returns the key and value.
- `DELETE /v1/kv/{url-encoded-key}` — returns 204 when deleted.
- `GET /v1/keys` — returns live keys in lexicographic order.
- `GET /health` — returns `{"status":"ok"}`.

All normal and error payloads are JSON. Request bodies are limited to 1 MiB.
State-changing requests are serialized, and each successful mutation is
committed by atomically replacing the data file. SIGINT and SIGTERM trigger a
clean shutdown.
