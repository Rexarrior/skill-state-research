# Persistent HTTP key-value service

Requires Python 3.11 or later; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data/state.json
```

Use `--port 0` to select a free port. The first stdout line is
`LISTENING <actual-port>`; diagnostics go to stderr.

* `PUT /v1/kv/{key}` accepts `{"value": ...}` and optional positive, finite
  `"ttl_seconds"`. Returns 201 on creation, 200 on replacement, with key/value JSON.
* `GET /v1/kv/{key}` returns `{"key": ..., "value": ...}`, or 404.
* `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
* `GET /v1/keys` returns live keys in lexicographic order as `{"keys": [...]}`.
* `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys in URLs. Keys must be nonempty and cannot contain `/`.
PUT bodies must be UTF-8 JSON objects containing `value` and optionally
`ttl_seconds`; additional fields are rejected. Bodies are limited to 1 MiB.
Errors are JSON objects with an `error` message. Chunked requests are unsupported;
send a Content-Length. Each HTTP connection serves one request.

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/hello%20world \
  -H 'Content-Type: application/json' \
  -d '{"value":{"message":"hello"},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/keys
```

Successful mutations synchronously write and fsync a temporary JSON file, then
atomically replace the data file. Requests share a lock so writes cannot lose
concurrent updates. Expiry uses absolute Unix timestamps and survives restarts;
expired entries are filtered on reads and removed from disk at startup, on the
next mutation, or at shutdown. Replacing a value without a TTL removes its TTL.
SIGTERM and Ctrl-C stop accepting requests, finish active handlers, and persist
live state. Incomplete requests time out after five seconds of inactivity.
Malformed existing data causes startup to fail instead of overwriting it.
Run only one service process per data file.

Run the integration tests (including ephemeral ports, concurrent writes,
validation, size limits, expiry, restart, and SIGTERM):

```sh
python3 -m unittest discover -v
```
