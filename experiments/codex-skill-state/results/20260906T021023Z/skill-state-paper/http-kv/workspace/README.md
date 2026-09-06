# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with atomic on-disk
persistence, optional per-key TTLs, and thread-safe concurrent requests.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to choose a free port. The first stdout line reports it as
`LISTENING <port>`; diagnostics are written to stderr. Stop the process with
SIGINT or SIGTERM.

## API

- `PUT /v1/kv/{url-encoded-key}` accepts
  `{"value": <any JSON value>, "ttl_seconds": <optional positive number>}`.
- `GET /v1/kv/{url-encoded-key}` retrieves a live value.
- `DELETE /v1/kv/{url-encoded-key}` deletes a live value.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns service health.

All non-empty requests and responses use `application/json`. Request bodies
are limited to 1 MiB. Keys are UTF-8, may contain spaces, and cannot be empty
or contain `/` (including an encoded slash).

Example:

```sh
curl -i -X PUT -H 'Content-Type: application/json' \
  --data '{"value":{"enabled":true},"ttl_seconds":60}' \
  'http://127.0.0.1:8080/v1/kv/my%20key'
curl -i 'http://127.0.0.1:8080/v1/kv/my%20key'
```
