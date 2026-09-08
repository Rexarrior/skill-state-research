# Persistent HTTP key-value service

This dependency-free Python 3.11+ service stores JSON values in an atomically
replaced JSON data file.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select a free port. The service prints `LISTENING <port>` as its
first stdout line; diagnostics are written to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` with
  `{"value": <any JSON value>, "ttl_seconds": <positive number>}`. The TTL is
  optional. Creates return 201 and replacements return 200.
- `GET /v1/kv/{url-encoded-key}` returns the stored key and value.
- `DELETE /v1/kv/{url-encoded-key}` deletes a live value and returns 204.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

All non-empty keys without `/` are supported, including URL-encoded spaces.
Requests and responses use JSON. Request bodies are limited to 1 MiB. Expired
values behave as missing and are removed from persistent state.

Example:

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/my%20key \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/my%20key
```
