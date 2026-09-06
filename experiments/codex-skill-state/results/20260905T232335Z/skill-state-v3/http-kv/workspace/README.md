# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with optional TTLs and atomic
on-disk persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select a free port; the process prints `LISTENING <port>` once
it is ready. Diagnostics are written to stderr. Send `SIGTERM` (or press
Ctrl-C) for a clean shutdown.

## API

- `PUT /v1/kv/{url-encoded-key}` — JSON body
  `{"value": <any JSON>, "ttl_seconds": <positive number, optional>}`.
- `GET /v1/kv/{url-encoded-key}` — retrieve a live value.
- `DELETE /v1/kv/{url-encoded-key}` — delete a live value.
- `GET /v1/keys` — list live keys in lexical order.
- `GET /health` — health check.

Requests and responses use JSON. Request bodies are limited to 1 MiB.

## Test

```sh
python3 -m unittest -v
```
