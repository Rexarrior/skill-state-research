# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON API whose state is atomically persisted to
disk.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select a free port; the service prints `LISTENING <port>` as its
first stdout line. Diagnostics go to stderr. Stop it with `SIGTERM` or Ctrl-C.

## API

```text
PUT    /v1/kv/{url-encoded-key}  {"value": ..., "ttl_seconds": 30}
GET    /v1/kv/{url-encoded-key}
DELETE /v1/kv/{url-encoded-key}
GET    /v1/keys
GET    /health
```

Keys are UTF-8 URL path components, may contain spaces, and cannot be empty or
contain `/`. `ttl_seconds` is optional and must be a finite positive number.
Request bodies are limited to 1 MiB. All API responses, including errors, use
JSON; a successful delete has an empty JSON response body.

Run the self-tests with:

```sh
python3 -m unittest -v
```
