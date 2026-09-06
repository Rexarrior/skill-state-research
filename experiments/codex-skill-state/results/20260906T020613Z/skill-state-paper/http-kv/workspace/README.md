# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with JSON values, optional TTLs,
thread-safe requests, and atomic on-disk persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Port `0` selects an available port. The service prints `LISTENING <port>` as
its first stdout line; request diagnostics go to stderr. SIGINT and SIGTERM
trigger a clean shutdown.

## API

- `PUT /v1/kv/{url-encoded-key}` accepts
  `{"value": <any JSON value>, "ttl_seconds": <positive finite number>}`.
  The TTL is optional. A create returns 201 and a replacement returns 200.
- `GET /v1/kv/{url-encoded-key}` returns the key and value.
- `DELETE /v1/kv/{url-encoded-key}` returns 204 when it deletes a live key.
- `GET /v1/keys` returns live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Request bodies must use `Content-Type: application/json` and may not exceed
1 MiB. Errors are JSON objects with an `error` field. Empty keys, invalid UTF-8,
slashes in decoded keys, malformed bodies, and invalid TTLs are rejected.

The data file is replaced atomically after every state change. Expired values
are removed on startup and whenever they are encountered, so they cannot return
after a restart.
