# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with JSON-file persistence, optional
per-key TTLs, atomic disk updates, and concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Using `--port 0` selects a free port; the service prints `LISTENING <port>` as
its first stdout line. Diagnostics go to stderr. Send `SIGTERM` or press Ctrl-C
for a clean shutdown.

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

Keys are URL-encoded UTF-8 strings. They may contain spaces but cannot be empty
or contain `/`. Request bodies are limited to 1 MiB. Every response other than
a successful `DELETE` (HTTP 204) is JSON.
