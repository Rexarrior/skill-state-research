# Persistent HTTP key-value service

This repository contains a dependency-free Python 3.11+ JSON HTTP service with
atomic on-disk persistence and optional per-key expiration.

Run it with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Passing `--port 0` chooses a free port. The first stdout line reports it as
`LISTENING <port>`; request logs and diagnostics go to stderr.

The API provides `PUT`, `GET`, and `DELETE` at `/v1/kv/{url-encoded-key}`, plus
`GET /v1/keys` and `GET /health`. A PUT body has the form
`{"value": <any JSON value>, "ttl_seconds": <optional positive number>}`.
Request bodies are limited to 1 MiB. Send `SIGTERM` or press Ctrl-C for a clean
shutdown.

Run the integration tests with:

```sh
python3 -m unittest -v
```
