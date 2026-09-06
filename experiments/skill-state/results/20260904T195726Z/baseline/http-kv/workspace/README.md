# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with atomic JSON-file persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints `LISTENING <port>` to
stdout when it is ready; diagnostics are written to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": <JSON>, "ttl_seconds": <number>?}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Keys may contain spaces but not slashes. TTLs are measured in seconds. Request
bodies are limited to 1 MiB. Live values are persisted after every mutation,
and expired values are removed when observed or when the service restarts.
