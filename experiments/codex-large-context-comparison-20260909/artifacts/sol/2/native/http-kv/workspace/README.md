# Persistent HTTP key-value service

This repository contains a dependency-free Python 3.11+ JSON HTTP service. Data is held in memory and committed to a JSON file with an atomic replacement after each mutation.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to choose a free port; the server prints `LISTENING <port>` as its first stdout line. Diagnostics go to stderr. Send `SIGTERM` or press Ctrl-C for a clean shutdown.

## API

```text
PUT    /v1/kv/{url-encoded-key}  {"value": <JSON>, "ttl_seconds": <positive number>?}
GET    /v1/kv/{url-encoded-key}
DELETE /v1/kv/{url-encoded-key}
GET    /v1/keys
GET    /health
```

Keys must be non-empty UTF-8 strings without `/`. Values may be any JSON value. TTLs are measured in seconds and use wall-clock expiry. Request bodies are limited to 1 MiB. Errors are JSON objects with an `error` field.

## Test

```sh
python3 -m unittest -v
```
