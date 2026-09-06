# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service that stores JSON values in an
atomically replaced JSON data file.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./store.json
```

Use `--port 0` to select a free port. The service prints exactly one startup
line to stdout (`LISTENING <port>`); request logs and errors go to stderr.

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

Keys are UTF-8 URL-encoded path components and may contain spaces, but not
slashes. Values may be any JSON value. Request bodies are limited to 1 MiB.
Optional `ttl_seconds` must be a finite positive number.

The process handles concurrent requests, removes expired records from durable
state, and exits cleanly on SIGTERM or Ctrl-C.
