# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with JSON values, optional TTLs,
thread-safe request handling, and atomic on-disk persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Using `--port 0` chooses a free port; the service prints `LISTENING <port>` as
its first stdout line. Diagnostics are written to stderr. Send `SIGTERM` or
press Ctrl-C for a clean shutdown.

## API

All request and response bodies are JSON. Keys are UTF-8 URL path components;
they may contain spaces but cannot be empty or contain `/` (including an
encoded slash).

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/health
```

`PUT` returns 201 when it creates a key and 200 when it replaces one. `GET`
returns 404 for missing or expired keys. `DELETE` returns 204 on success and
404 when absent. Request bodies are limited to 1 MiB.

## Tests

```sh
python3 -m unittest -v
```
