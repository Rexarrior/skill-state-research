# Persistent HTTP key-value service

This project is a dependency-free Python 3.11+ HTTP key-value server with
atomic JSON-file persistence and optional per-key expiration.

Start it with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to choose a free port; the server prints `LISTENING <port>` as its
first stdout line. Diagnostics and request logs go to stderr. Stop the process
with `SIGTERM` or Ctrl-C for a clean shutdown.

Examples:

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/health
```

Keys are UTF-8 URL path components and must be nonempty and contain no slash.
Request bodies are limited to 1 MiB. Every response with a body is JSON.
