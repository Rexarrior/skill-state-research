# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with JSON-file persistence, TTLs,
atomic writes, and thread-safe concurrent request handling.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Using `--port 0` chooses a free port; read `LISTENING <port>` from the first
stdout line. Diagnostics are written to stderr. Send `SIGTERM` (or press
Ctrl-C) for a clean shutdown.

## API

- `PUT /v1/kv/{url-encoded-key}` — body
  `{"value": <any JSON>, "ttl_seconds": <positive finite number>}`. The TTL is
  optional. Returns 201 when creating and 200 when replacing.
- `GET /v1/kv/{url-encoded-key}` — fetch a live value.
- `DELETE /v1/kv/{url-encoded-key}` — delete a live value (204).
- `GET /v1/keys` — list live keys in lexicographic order.
- `GET /health` — liveness response.

Requests and non-empty responses are JSON. PUT bodies are limited to 1 MiB.

## Self-tests

```sh
python3 -m unittest -v
```
