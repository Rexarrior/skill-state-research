# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic file persistence,
optional per-key TTLs, and concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select an available port. The first stdout line reports it as
`LISTENING <port>`; request logs and diagnostics go to stderr.

## API

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/health
```

Keys are UTF-8 URL path segments and may contain spaces but not `/`. Request and
response bodies are JSON. PUT bodies are limited to 1 MiB.

## Test

```sh
python3 -m unittest -v test_server.py
```
