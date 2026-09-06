# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with JSON-file persistence, optional
per-key TTLs, atomic writes, and concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data/store.json
```

Port `0` asks the OS for a free port. The service prints only
`LISTENING <actual-port>` to stdout; request diagnostics go to stderr. Stop it
with `SIGINT` or `SIGTERM` for a clean shutdown.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": <JSON>, "ttl_seconds": <positive number>}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

For example:

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"enabled":true},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
```

Request bodies are limited to 1 MiB. Keys must be non-empty UTF-8 strings and
cannot contain `/`, including an encoded slash.

## Tests

```sh
python3 -m unittest -v
```
