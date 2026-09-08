# Persistent HTTP key-value service

Requires Python 3.11 or newer; no third-party dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 8000 --data ./state.json
```

Use `--port 0` to choose a free port. The first stdout line is
`LISTENING <actual-port>`; diagnostics go to stderr. SIGTERM and Ctrl-C stop
accepting requests, finish active requests, and persist live state.

| Request | Result |
| --- | --- |
| `PUT /v1/kv/{key}` | JSON `{"value": ANY, "ttl_seconds": NUMBER?}`; 201 when created, 200 when replaced |
| `GET /v1/kv/{key}` | `{"key": KEY, "value": ANY}`; 404 when missing or expired |
| `DELETE /v1/kv/{key}` | 204 with no body, or 404 when missing |
| `GET /v1/keys` | `{"keys": [...]}` sorted by key, excluding expired entries |
| `GET /health` | `{"status":"ok"}` |

Percent-encode keys as UTF-8. Keys must be nonempty and cannot contain `/`.
TTL must be a finite positive JSON number; omission removes any previous TTL.
Errors are JSON objects with an `error` field. PUT accepts only `value` and
optional `ttl_seconds`. Nonstandard JSON numbers such as NaN are rejected.
Request bodies are limited to 1 MiB; use Content-Length (chunked uploads are
unsupported). Connections close after each request and have a five-second
socket timeout.

```sh
curl -X PUT http://127.0.0.1:8000/v1/kv/hello%20world \
  -H 'Content-Type: application/json' \
  -d '{"value":{"message":"hi"},"ttl_seconds":60}'
curl http://127.0.0.1:8000/v1/keys
```

Writes serialize under a lock and are acknowledged after flushing a temporary
JSON file and atomically replacing the state file. Expiry uses absolute Unix
timestamps, so time spent offline counts toward TTL. Expired entries are
filtered on reads and removed from disk on the next write, startup, or clean
shutdown. Invalid state files cause startup to fail rather than discard data.
Run one server process per state file; this service has no authentication and
is intended for trusted clients. Persistence rewrites the complete live state.

Run the HTTP integration tests, including concurrency and restart checks:

```sh
python3 -m unittest -v
```
