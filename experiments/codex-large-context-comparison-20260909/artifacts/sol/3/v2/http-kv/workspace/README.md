# Persistent HTTP key-value service

This repository contains a dependency-free Python 3.11+ JSON HTTP service.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to choose a free port; the service prints `LISTENING <port>` as
its first stdout line. Diagnostics are written to stderr. Data is durably
written through atomic file replacement, and optional TTLs survive restarts.

Endpoints are `PUT /v1/kv/{url-encoded-key}`, `GET /v1/kv/{key}`,
`DELETE /v1/kv/{key}`, `GET /v1/keys`, and `GET /health`. A PUT body has the
form `{"value": <any JSON value>, "ttl_seconds": <optional positive number>}`.
Request bodies are limited to 1 MiB.

Run the self-tests with:

```sh
python3 -m unittest -v
```
