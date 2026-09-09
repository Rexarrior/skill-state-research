# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence and optional per-key TTLs.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8000 --data ./data.json
```

Use `--port 0` to select a free port. The first stdout line reports it as `LISTENING <port>`; request logs and diagnostics go to stderr.

## API

```sh
curl -X PUT http://127.0.0.1:8000/v1/kv/greeting \
  -H 'Content-Type: application/json' \
  -d '{"value":"hello","ttl_seconds":60}'
curl http://127.0.0.1:8000/v1/kv/greeting
curl http://127.0.0.1:8000/v1/keys
curl -X DELETE http://127.0.0.1:8000/v1/kv/greeting
curl http://127.0.0.1:8000/health
```

Keys are URL-encoded UTF-8 strings. They may contain spaces but not `/`. Request bodies are limited to 1 MiB. The data file is replaced atomically after every mutation and expired records are removed during startup and access.
