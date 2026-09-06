# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with atomic JSON-file persistence,
optional TTLs, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port; the service prints `LISTENING <port>` as
its first stdout line. Diagnostics are written to stderr. Send `SIGTERM` or
press Ctrl-C for a clean shutdown.

## API

All response bodies are JSON. Keys must be URL-encoded UTF-8, non-empty, and
may not contain `/` after decoding. Request bodies are limited to 1 MiB.

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/my%20key \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/my%20key
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/my%20key
curl http://127.0.0.1:8080/health
```

`PUT` returns 201 when creating and 200 when replacing. `GET` returns the
stored key/value, and `DELETE` returns 204. Missing or expired keys return 404.
Invalid requests and unknown routes return structured 4xx JSON errors.
