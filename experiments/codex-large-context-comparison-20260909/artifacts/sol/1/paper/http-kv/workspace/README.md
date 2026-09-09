# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with JSON-file persistence, optional TTLs, and concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./store.json
```

Use `--port 0` to select a free port. The service prints `LISTENING <port>` to stdout when it is ready; request logs and diagnostics go to stderr. Send `SIGTERM` or press Ctrl-C for a clean shutdown.

## API

- `PUT /v1/kv/{url-encoded-key}` — JSON body `{"value": ..., "ttl_seconds": 60}`; TTL is optional.
- `GET /v1/kv/{url-encoded-key}` — retrieve a live value.
- `DELETE /v1/kv/{url-encoded-key}` — delete a live value.
- `GET /v1/keys` — list live keys in lexicographic order.
- `GET /health` — health check.

All response bodies are JSON except a successful delete (`204 No Content`). Request bodies are limited to 1 MiB. Values may be any valid JSON value.

Example:

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/greeting \
  -H 'Content-Type: application/json' \
  --data '{"value":"hello","ttl_seconds":300}'
curl http://127.0.0.1:8080/v1/kv/greeting
```
