# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service that stores arbitrary JSON values,
supports optional TTLs, and atomically persists live entries to disk.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The first stdout line reports it as
`LISTENING <port>`. Diagnostics are written to stderr.

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

Keys are UTF-8 URL-encoded path segments. They may contain spaces, but cannot
be empty or contain `/`. Request bodies are limited to 1 MiB. Stop the service
with `SIGTERM` or `Ctrl-C`; committed state remains available after restart.
