# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with JSON persistence, optional
per-key TTLs, concurrent request handling, and atomic file replacement.

## Start

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints exactly one startup
line to stdout (`LISTENING <port>`); request diagnostics go to stderr.

## API examples

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -i -X DELETE http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/health
```

Keys must be UTF-8 URL-encoded, non-empty, and cannot contain `/`. Request and
response bodies are JSON. PUT bodies are limited to 1 MiB and must contain a
`value`; `ttl_seconds`, when supplied, must be a finite positive number.

Stop the process with `SIGTERM` or Ctrl-C. Live state is flushed before exit.
