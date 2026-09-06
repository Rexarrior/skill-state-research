# Persistent HTTP key-value service

This dependency-free Python 3.11+ service stores arbitrary JSON values in an atomically replaced JSON file. It supports concurrent requests, optional expirations, restart persistence, and graceful SIGTERM/SIGINT shutdown.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select a free port; the first stdout line reports it as `LISTENING <port>`. Diagnostics are written to stderr.

The API provides `PUT`, `GET`, and `DELETE /v1/kv/{url-encoded-key}`, `GET /v1/keys`, and `GET /health`. PUT bodies have the form `{"value": <any JSON value>, "ttl_seconds": <optional positive number>}`. Request bodies are limited to 1 MiB.

Run the integration tests with:

```sh
python3 -m unittest -v
```
