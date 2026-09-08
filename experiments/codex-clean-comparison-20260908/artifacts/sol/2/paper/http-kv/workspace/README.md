# Persistent HTTP key-value service

This project provides a dependency-free Python 3.11+ HTTP JSON service backed by
an atomically replaced JSON data file.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Using `--port 0` selects an available port. The first stdout line reports it as
`LISTENING <port>`; request logs and diagnostics go to stderr. Send SIGTERM or
press Ctrl-C for a clean shutdown.

## API

- `PUT /v1/kv/{url-encoded-key}` with `{"value": ..., "ttl_seconds": 30}`
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Keys are UTF-8, non-empty, and cannot contain `/`. TTL is optional and is a
finite number greater than zero. Request bodies are limited to 1 MiB. All
responses other than a successful 204 deletion are JSON.

Example:

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl -i http://127.0.0.1:8080/v1/kv/example
curl -i http://127.0.0.1:8080/v1/keys
```

Live entries are written after every mutation using a temporary file, `fsync`,
and atomic replacement. Expiration times are absolute, so expired entries stay
expired across restarts.

## Self-test

Start the service with a temporary data path, exercise the endpoints with
`curl`, restart with the same path to check persistence, and inspect stdout to
verify that only the `LISTENING` line is emitted.
