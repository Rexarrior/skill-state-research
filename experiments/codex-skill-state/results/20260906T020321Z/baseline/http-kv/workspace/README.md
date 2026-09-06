# Persistent HTTP key-value service

Dependency-free Python 3.11+ HTTP service with atomic JSON-file persistence,
optional per-key TTLs, and thread-safe concurrent request handling.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data/store.json
```

Use `--port 0` to select an available port. The service prints only
`LISTENING <port>` to stdout when ready; request diagnostics go to stderr.

The JSON API provides `PUT`, `GET`, and `DELETE /v1/kv/{encoded-key}`,
`GET /v1/keys`, and `GET /health`. A PUT body has the form
`{"value": <any JSON value>, "ttl_seconds": <optional positive finite number>}`.
Request bodies are limited to 1 MiB.

Run the self-tests with:

```sh
python3 -m unittest -v
```
