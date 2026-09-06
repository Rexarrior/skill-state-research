# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence, optional TTLs, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8000 --data ./data.json
```

Use `--port 0` to select a free port; the service prints `LISTENING <port>` to stdout. Diagnostics go to stderr. Stop it cleanly with `SIGTERM` or Ctrl-C.

## API

```sh
curl -X PUT http://127.0.0.1:8000/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"hello":"world"},"ttl_seconds":60}'
curl http://127.0.0.1:8000/v1/kv/example
curl http://127.0.0.1:8000/v1/keys
curl -X DELETE http://127.0.0.1:8000/v1/kv/example
curl http://127.0.0.1:8000/health
```

Keys are UTF-8 URL path components and may contain spaces but not `/`. PUT request bodies are limited to 1 MiB. Live state is written to the data file using atomic replacement and restored at startup.
