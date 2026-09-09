# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with TTLs and atomic file
persistence.

Start the server with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port; the selected port is printed as
`LISTENING <port>`. Diagnostics are written to stderr.

Examples:

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  --data '{"value":{"message":"hello"},"ttl_seconds":60}'
curl -i http://127.0.0.1:8080/v1/kv/example
curl -i http://127.0.0.1:8080/v1/keys
curl -i -X DELETE http://127.0.0.1:8080/v1/kv/example
curl -i http://127.0.0.1:8080/health
```

Keys are UTF-8 URL path segments. They may contain spaces (URL-encoded as
`%20`) but cannot be empty or contain `/`. Request bodies are limited to 1 MiB.
Mutations are serialized, persisted via atomic replacement, and retained across
restarts. Expired records are removed from durable state.
