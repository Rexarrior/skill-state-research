# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic file persistence,
optional TTLs, and concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints exactly one startup line
to stdout, `LISTENING <port>`; request logs and diagnostics go to stderr. Send
SIGTERM or press Ctrl-C for a clean shutdown.

## API

All request and response bodies are JSON. Keys must be URL-encoded and may contain
spaces but not slashes.

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -i -X DELETE http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/health
```

`PUT` returns 201 when creating and 200 when replacing. `GET` returns 404 for
missing or expired entries, and `DELETE` returns 204 when it removes an entry.
Requests larger than 1 MiB are rejected.
