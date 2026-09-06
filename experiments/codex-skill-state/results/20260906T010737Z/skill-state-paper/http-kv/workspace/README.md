# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence,
optional TTLs, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints `LISTENING <port>` to
stdout once it is ready; request diagnostics go to stderr. Send `SIGTERM` or
press Ctrl-C for a clean shutdown.

## API

All request and response bodies are JSON. Keys are URL-encoded UTF-8 path
components; they may contain spaces but not `/`.

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/health
```

`PUT` returns 201 when creating and 200 when replacing. `GET` and `DELETE`
return 404 for missing or expired keys. Request bodies are limited to 1 MiB.

## Self-check

The implementation can be syntax-checked with:

```sh
python3 -m py_compile server.py
```
