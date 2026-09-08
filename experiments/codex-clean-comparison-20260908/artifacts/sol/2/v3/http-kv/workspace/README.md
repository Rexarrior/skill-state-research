# Persistent HTTP key-value service

This project is a dependency-free Python 3.11+ HTTP service backed by an atomically replaced JSON file.

Start it with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select an available port; the first stdout line reports it as `LISTENING <port>`. Diagnostics are written to stderr. SIGINT and SIGTERM stop the server cleanly.

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

Keys are UTF-8 URL-encoded path segments. They may contain spaces but cannot be empty or contain `/`. PUT request bodies are JSON objects containing `value` and, optionally, a finite positive `ttl_seconds`. Request bodies are limited to 1 MiB.
