# Persistent HTTP key-value service

A dependency-free Python 3.11+ service that stores arbitrary JSON values in an
atomically replaced JSON file.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Using `--port 0` selects a free port; the service prints `LISTENING <port>` as
its first stdout line. Request diagnostics go to stderr. SIGINT and SIGTERM
perform a clean shutdown.

## API

- `PUT /v1/kv/{URL-encoded-key}` with `{"value": <JSON>, "ttl_seconds": 60}`
- `GET /v1/kv/{URL-encoded-key}`
- `DELETE /v1/kv/{URL-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Keys are UTF-8, non-empty, and cannot contain `/`. TTLs are optional, finite,
and positive. Request bodies are limited to 1 MiB. All non-204 responses are
JSON.

## Self-test

```sh
python3 -m unittest -v
```
