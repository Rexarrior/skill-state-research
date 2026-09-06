# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON service with atomic file persistence, TTLs,
thread-safe concurrent requests, and graceful SIGTERM shutdown.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select a free port. The first stdout line reports it as
`LISTENING <port>`; request diagnostics go to stderr.

## API

- `PUT /v1/kv/<url-encoded-key>` — body `{"value": <any JSON>, "ttl_seconds": <positive number>}`;
  `ttl_seconds` is optional.
- `GET /v1/kv/<url-encoded-key>` — fetch a live value.
- `DELETE /v1/kv/<url-encoded-key>` — delete a live value.
- `GET /v1/keys` — list live keys in lexicographic order.
- `GET /health` — liveness response.

Requests and non-empty responses use JSON. Request bodies are limited to 1 MiB.

## Tests

```sh
python3 -m unittest -v
```
