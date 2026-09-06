# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service backed by an atomically replaced
JSON file.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to let the operating system choose a free port. The first line
on stdout is always `LISTENING <actual-port>` and is flushed immediately.
Diagnostics are written to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with
  `{"value": <any JSON value>, "ttl_seconds": <positive finite number>}`.
  `ttl_seconds` is optional. Returns `201` when creating and `200` when
  replacing a live key.
- `GET /v1/kv/{url-encoded-key}` returns `{"key": ..., "value": ...}`.
- `DELETE /v1/kv/{url-encoded-key}` returns `204` when deleted.
- `GET /v1/keys` returns live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Keys must be non-empty UTF-8 strings and may contain spaces, but not `/` (even
when URL-encoded). Expired or absent keys return `404`. Invalid requests,
unknown routes, and unsupported methods return a JSON error response. Request
bodies are limited to 1 MiB.

The data file is written after every mutation using `fsync` followed by atomic
replacement. Expired entries are removed during normal access and on startup.
The server handles requests concurrently, serializes state changes, and exits
cleanly on `SIGTERM`.
