# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence,
optional TTLs, and concurrent request handling.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to let the operating system choose a free port; the service prints
`LISTENING <port>` as its first stdout line. Diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` — body: `{"value": ..., "ttl_seconds": 60}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Keys must be non-empty UTF-8 strings without `/`. Request bodies are limited to
1 MiB. TTL values must be finite numbers greater than zero.

Run the self-tests with:

```sh
python3 -m unittest -v
```
