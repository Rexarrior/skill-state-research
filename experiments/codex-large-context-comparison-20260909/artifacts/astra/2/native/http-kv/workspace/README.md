# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data/state.json
```

The first stdout line is `LISTENING <actual-port>`. Request logs and diagnostics go
to stderr. SIGTERM or Ctrl-C stops accepting requests and waits for active handlers.

- `PUT /v1/kv/{key}` with JSON `{"value": ..., "ttl_seconds": 60}` creates (201)
  or replaces (200) a value. Omit TTL for permanent storage; TTL must be a finite,
  positive number. PUT returns the key and value.
- `GET /v1/kv/{key}` returns `{"key": ..., "value": ...}` or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` returns `{"keys": [...]}` sorted by key.
- `GET /health` returns `{"status":"ok"}`.

URL-encode UTF-8 keys; empty keys and slashes are invalid. PUT accepts a JSON
object containing `value` and optionally `ttl_seconds`; other fields are rejected.
Request bodies are limited to 1 MiB and use Content-Length (chunked transfer is
unsupported). Errors return JSON with an `error` message.

Writes are serialized with a lock, flushed to a temporary file in the data
file's directory, and atomically replace the state file before success is
returned. Expiration uses absolute Unix timestamps and survives restarts.
Expired values are ignored and omitted from subsequent writes. Invalid state
files cause startup to fail instead of being overwritten. Run only one server
process per data file. This service has no authentication or TLS; the default
bind address is loopback.

Run the integration tests:

```sh
python3 -m unittest -v
```
