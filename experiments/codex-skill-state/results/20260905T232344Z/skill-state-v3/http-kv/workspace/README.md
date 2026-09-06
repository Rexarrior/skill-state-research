# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON service with atomic on-disk persistence and optional per-key TTLs.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./store.json
```

Use `--port 0` to select a free port. The service prints `LISTENING <port>` as its first stdout line; diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": <any JSON>, "ttl_seconds": <positive number>?}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Keys are UTF-8 path segments: they may contain spaces but cannot be empty or contain `/`. Request bodies are limited to 1 MiB. Data is written to a temporary file in the destination directory, synced, and atomically replaced. SIGTERM and SIGINT trigger a clean shutdown.

## Test

```sh
python3 -m unittest -v
```
