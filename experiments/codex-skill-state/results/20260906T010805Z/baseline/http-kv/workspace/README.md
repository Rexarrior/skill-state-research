# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with JSON-file persistence, optional
per-key TTLs, atomic updates, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Port `0` selects a free port; the server prints `LISTENING <port>` to stdout.
Diagnostics are written to stderr. Stop the service with `SIGTERM` or Ctrl-C.

## API

```text
PUT    /v1/kv/{url-encoded-key}   {"value": <any JSON>, "ttl_seconds": 30}
GET    /v1/kv/{url-encoded-key}
DELETE /v1/kv/{url-encoded-key}
GET    /v1/keys
GET    /health
```

Keys must be non-empty UTF-8 strings without `/`. `ttl_seconds` is optional and
must be a finite number greater than zero. Request bodies are limited to 1 MiB.

Example:

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/hello%20world \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl -i http://127.0.0.1:8080/v1/kv/hello%20world
curl -i http://127.0.0.1:8080/v1/keys
```
