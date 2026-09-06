# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with atomic JSON-file persistence,
optional per-key TTLs, and thread-safe concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Port `0` asks the OS for a free port. The server prints `LISTENING <port>` as
its first stdout line; request diagnostics go to stderr. `SIGINT` and `SIGTERM`
stop it cleanly.

## API

- `PUT /v1/kv/{url-encoded-key}` — JSON body
  `{"value": <any JSON>, "ttl_seconds": <positive finite number>}`. The TTL is
  optional. Returns 201 for a new key and 200 for a replacement.
- `GET /v1/kv/{url-encoded-key}` — returns the key and value.
- `DELETE /v1/kv/{url-encoded-key}` — returns 204 when deleted.
- `GET /v1/keys` — returns live keys in lexicographic order.
- `GET /health` — liveness response.

Requests and non-empty responses are JSON. PUT bodies are limited to 1 MiB.
Keys must be non-empty UTF-8 strings without `/`; spaces must be URL-encoded.

## Test

```sh
python3 -m unittest -v
```
