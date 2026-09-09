# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON service with atomic on-disk persistence,
optional TTLs, concurrent request handling, and clean SIGTERM shutdown.

Start the server with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to choose a free port; the first stdout line reports it as
`LISTENING <port>`. Diagnostics are written to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` accepts `{"value": <any JSON>,
  "ttl_seconds": <positive finite number>}`. The TTL is optional.
- `GET /v1/kv/{url-encoded-key}` retrieves a live value.
- `DELETE /v1/kv/{url-encoded-key}` deletes a live value.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns service health.

Keys must be non-empty UTF-8 strings and cannot contain `/`. Request bodies are
limited to 1 MiB. All non-empty responses, including errors, are JSON.
