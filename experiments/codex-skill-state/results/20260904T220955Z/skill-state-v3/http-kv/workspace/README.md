# Persistent HTTP key-value service

Dependency-free Python 3.11+ JSON HTTP key-value server with optional per-key TTL
and atomic JSON-file persistence.

Run it with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to choose a free port; the first stdout line is `LISTENING PORT`.

Endpoints: `PUT`, `GET`, and `DELETE /v1/kv/{url-encoded-key}`, `GET /v1/keys`,
and `GET /health`. PUT accepts `{"value": ..., "ttl_seconds": ...}`; TTL is
optional, finite, and positive. Bodies are capped at 1 MiB.

Run the self-tests:

```sh
python3 -m unittest -v test_server.py
```
