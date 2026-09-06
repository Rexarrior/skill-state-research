# Persistent HTTP key-value service

Dependency-free Python 3.11+ HTTP service with JSON values, optional TTLs,
thread-safe requests, and atomic on-disk persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data/store.json
```

Use port `0` to select a free port. The service prints `LISTENING <port>` as
its first stdout line. Diagnostics are written to stderr.

## API

```text
PUT    /v1/kv/{url-encoded-key}  {"value": ..., "ttl_seconds": 60}
GET    /v1/kv/{url-encoded-key}
DELETE /v1/kv/{url-encoded-key}
GET    /v1/keys
GET    /health
```

All non-empty responses are JSON. Request bodies are limited to 1 MiB.

## Tests

```sh
python3 -m unittest -v
```
