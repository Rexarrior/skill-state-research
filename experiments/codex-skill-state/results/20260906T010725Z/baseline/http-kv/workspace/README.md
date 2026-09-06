# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON API with TTL support and atomic on-disk persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to choose a free port. The service prints `LISTENING <port>` to stdout when it is ready; request logs and errors go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` — body `{"value": <json>, "ttl_seconds": <positive number>}` (`ttl_seconds` is optional).
- `GET /v1/kv/{url-encoded-key}` — fetch a live value.
- `DELETE /v1/kv/{url-encoded-key}` — delete a live value.
- `GET /v1/keys` — list live keys in lexical order.
- `GET /health` — readiness check.

Example:

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/hello%20world \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/hello%20world
```

## Test

```sh
python3 -m unittest -v
```
