# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with TTL support and atomic
on-disk persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8000 --data ./data.json
```

Passing `--port 0` selects an available port and prints it as
`LISTENING <port>`. Diagnostics go to stderr. Stop the process with SIGTERM or
Ctrl-C for a clean shutdown.

## API

```text
PUT    /v1/kv/{url-encoded-key}  {"value": ..., "ttl_seconds": 30}
GET    /v1/kv/{url-encoded-key}
DELETE /v1/kv/{url-encoded-key}
GET    /v1/keys
GET    /health
```

Request bodies must use `Content-Type: application/json` and may be at most
1 MiB. Keys may contain spaces but cannot be empty or contain `/` after URL
decoding. `ttl_seconds` is optional and must be a finite positive number.

## Test

```sh
python3 -m unittest -v test_server.py
```
