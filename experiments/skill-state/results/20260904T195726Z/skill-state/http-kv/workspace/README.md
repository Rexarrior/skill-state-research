# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with optional TTLs and
atomic file persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints only
`LISTENING <port>` to stdout on startup; request logs go to stderr.

## API

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"message":"hello"},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/health
```

Keys are URL-encoded UTF-8 strings without `/`. PUT bodies are limited to
1 MiB. Values may be any JSON value. The data file is replaced atomically
after each change, and expired records are excluded from reads and recovery.
