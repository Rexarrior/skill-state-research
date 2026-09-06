# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with JSON-file persistence, optional
per-key TTLs, atomic updates, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Port `0` selects a free port. The service prints `LISTENING <port>` to stdout
when ready; request logs and diagnostics go to stderr. `SIGINT` and `SIGTERM`
trigger a clean shutdown.

## API

All response bodies are JSON (a successful `DELETE` has no body). Keys must be
URL-encoded UTF-8, may contain spaces, and cannot be empty or contain `/`.

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -i -X DELETE http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/health
```

`PUT` returns 201 when creating a key and 200 when replacing one. Requests are
limited to 1 MiB. Live state is atomically written to the path passed via
`--data` and is loaded again on restart; expired entries are discarded.
