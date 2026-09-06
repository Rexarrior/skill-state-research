# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk persistence.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select a free port; the service prints `LISTENING <port>` as its
first stdout line. Diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` — body: `{"value": <JSON>, "ttl_seconds": <positive number>}` (`ttl_seconds` is optional)
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Keys are UTF-8, non-empty, and cannot contain `/`. Request bodies are limited to
1 MiB. Entries are written with an atomic file replacement and expired entries
are removed on startup and while serving requests.

Run the self-tests with:

```sh
python3 -m unittest -v
```
