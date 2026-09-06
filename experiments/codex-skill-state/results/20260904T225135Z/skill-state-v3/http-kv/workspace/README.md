# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON service with atomic on-disk persistence,
optional TTLs, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./state.json
```

Use `--port 0` to select a free port. The service prints its selected port as
`LISTENING <port>` on stdout; request logs and diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": ..., "ttl_seconds": 60}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Keys must be non-empty UTF-8 strings without `/`. Request bodies are limited to
1 MiB. The data file is updated by atomic replacement after every mutation.

## Self-tests

```sh
python3 -m unittest -v
```
