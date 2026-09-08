# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service that stores arbitrary JSON values,
optionally expires them, and atomically persists live state to disk.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select an available port. The service prints
`LISTENING <port>` to stdout when it is ready; diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with
  `{"value": <any JSON>, "ttl_seconds": <positive finite number>}`. The TTL is
  optional. A create returns 201 and a replacement returns 200.
- `GET /v1/kv/{url-encoded-key}` returns the key and value.
- `DELETE /v1/kv/{url-encoded-key}` removes a live value and returns 204.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns service health.

All response content types are `application/json`; errors have an `error`
field. Request bodies are limited to 1 MiB. Send `SIGTERM` or press Ctrl-C for
a clean shutdown.

Example:

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/my%20key \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl -i http://127.0.0.1:8080/v1/kv/my%20key
```
