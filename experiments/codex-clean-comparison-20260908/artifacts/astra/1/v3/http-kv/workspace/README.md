# Persistent HTTP key-value service

Requires Python 3.11+ and uses only the standard library.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Request logs and diagnostics
use stderr. SIGTERM and Ctrl-C stop accepting requests and wait for active handlers.

- `PUT /v1/kv/{key}` with `{"value": ANY, "ttl_seconds": NUMBER?}` creates (201)
  or replaces (200) an entry. Omit TTL for no expiration; replacing resets TTL.
- `GET /v1/kv/{key}` returns `{"key": KEY, "value": ANY}` or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` returns live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys in the URL. Keys must be nonempty and cannot contain `/`.
Bodies use UTF-8 JSON, with a 1 MiB limit and Content-Length framing (chunked
requests are unsupported). TTL must be a finite positive number, excluding booleans.
Errors are JSON. PUT accepts only `value` and optional `ttl_seconds` fields.

Writes serialize under a lock and flush a temporary snapshot before atomic
replacement. Expiration timestamps persist across restarts. Expired records are
removed on startup and subsequent store operations; they are never returned.
Use one server process per data file. Invalid existing snapshots fail startup
rather than silently discarding data. Connections have a five-second I/O timeout.

Run integration tests:

```sh
python3 -m unittest discover -v
```
