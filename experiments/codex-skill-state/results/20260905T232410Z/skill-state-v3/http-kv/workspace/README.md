# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence,
optional TTLs, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints `LISTENING <port>` as
its first stdout line. Request diagnostics are written to stderr.

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

Keys are UTF-8 URL path segments and therefore must URL-encode spaces and other
special characters. Keys cannot be empty or contain `/`. PUT bodies accept a
required `value` containing any JSON value and an optional positive, finite
`ttl_seconds`. Request bodies are limited to 1 MiB.

The data file is replaced atomically after every mutation. Stop the process with
SIGTERM or Ctrl-C for a clean shutdown.
