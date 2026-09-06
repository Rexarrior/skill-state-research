# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with TTLs and atomic,
thread-safe persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Passing `--port 0` selects a free port; the first stdout line reports it as
`LISTENING <port>`. Diagnostics are written to stderr. Send `SIGTERM` or press
Ctrl-C for a clean shutdown.

## API

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"message":"hello"},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -i -X DELETE http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/health
```

Keys are URL-encoded UTF-8 strings. They may contain spaces but cannot be empty
or contain `/`. PUT bodies require `value` (any JSON value) and may contain a
finite, positive `ttl_seconds`. Request bodies are limited to 1 MiB.

The data file is replaced atomically after every mutation. Expired records are
removed during startup and normal access, so they do not return after restart.

## Tests

```sh
python3 -m unittest -v
```

The integration tests launch the server on a free port and cover CRUD,
validation, body limits, TTL expiry, persistence, restart, and clean shutdown.
