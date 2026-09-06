# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with TTL support and atomic
on-disk persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints
`LISTENING <actual-port>` to stdout when ready; diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": ..., "ttl_seconds": 60}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Entries are written to the configured JSON file by atomic replacement. TTL is
optional and is measured in seconds.
