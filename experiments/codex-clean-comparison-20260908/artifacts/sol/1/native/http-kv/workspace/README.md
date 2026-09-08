# Persistent HTTP key-value service

This repository contains a dependency-free Python 3.11+ JSON HTTP service.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to let the operating system choose an available port; the service
prints `LISTENING <port>` as its first stdout line. Diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": ..., "ttl_seconds": 30}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Keys are UTF-8 URL path components and cannot be empty or contain `/`. TTL is
optional and is measured in seconds. Data is rewritten atomically after every
mutation. Request bodies are limited to 1 MiB.

Run the standard-library integration tests with:

```sh
python3 -m unittest -v
```
