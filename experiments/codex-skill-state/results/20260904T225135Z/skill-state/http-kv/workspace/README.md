# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with JSON persistence, optional
per-key TTLs, atomic file replacement, and concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints
`LISTENING <actual-port>` as its first stdout line. Diagnostics go to stderr.

## API

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl -i http://127.0.0.1:8080/v1/kv/example
curl -i http://127.0.0.1:8080/v1/keys
curl -i -X DELETE http://127.0.0.1:8080/v1/kv/example
curl -i http://127.0.0.1:8080/health
```

Keys must be UTF-8 URL-encoded, non-empty, and cannot contain `/`. Request
bodies are limited to 1 MiB. The data file's parent directory must exist.
