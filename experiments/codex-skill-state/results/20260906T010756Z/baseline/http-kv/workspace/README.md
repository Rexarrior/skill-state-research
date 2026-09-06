# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence,
optional TTLs, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints only
`LISTENING <actual-port>` to stdout; request and error logs go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` — body: `{"value": <JSON>, "ttl_seconds": <positive number>}`;
  `ttl_seconds` is optional.
- `GET /v1/kv/{url-encoded-key}` — retrieve a live value.
- `DELETE /v1/kv/{url-encoded-key}` — delete a live value.
- `GET /v1/keys` — list live keys in lexicographic order.
- `GET /health` — liveness check.

All non-empty response bodies are JSON. Request bodies are limited to 1 MiB.
Stop the server with `SIGTERM` or `Ctrl-C`; committed state survives restart.

## Test

```sh
python3 -m unittest -v
```
