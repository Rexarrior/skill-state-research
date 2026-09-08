# Persistent HTTP key-value service

This dependency-free Python 3.11+ service stores JSON values in an atomically
replaced JSON file.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select an available port; the server prints `LISTENING <port>`
once it is ready. Diagnostics go to stderr. Send `SIGTERM` (or press Ctrl-C) for
a clean shutdown.

Examples:

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/example
```

Keys are UTF-8 URL path components (for example, `hello%20world`); empty keys
and keys containing `/`, including percent-encoded slashes, are rejected.
