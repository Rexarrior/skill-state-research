# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service whose state is saved atomically to a
JSON file.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints
`LISTENING <actual-port>` to stdout when it is ready; request logs and errors go
to stderr.

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

Keys are UTF-8 URL path segments and may contain spaces but not `/`. PUT bodies
must contain `value` (any JSON value) and may contain a finite, positive
`ttl_seconds`. Request bodies are limited to 1 MiB. Expired values are omitted
from reads, listings, and persisted state.

## Self-check

```sh
python3 -m py_compile server.py
```

The service handles requests concurrently, serializes mutations, uses atomic
file replacement, and shuts down cleanly on SIGINT or SIGTERM.
