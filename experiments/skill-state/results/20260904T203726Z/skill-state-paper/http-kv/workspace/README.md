# Persistent HTTP key-value service

Dependency-free Python 3.11+ JSON key-value HTTP service with optional TTLs and atomic persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <port>`. Diagnostics are written to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}`: JSON body `{"value": any, "ttl_seconds": optional-positive-number}`; returns 201 when creating and 200 when replacing.
- `GET /v1/kv/{url-encoded-key}`: returns the key and value, or 404.
- `DELETE /v1/kv/{url-encoded-key}`: returns 204, or 404.
- `GET /v1/keys`: returns sorted live keys.
- `GET /health`: returns `{"status":"ok"}`.

Example:

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/hello%20world -d '{"value":{"answer":42}}'
curl http://127.0.0.1:8080/v1/kv/hello%20world
```
