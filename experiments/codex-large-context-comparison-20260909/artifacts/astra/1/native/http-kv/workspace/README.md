# Persistent HTTP key-value service

Requires Python 3.11 or newer; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
SIGTERM or Ctrl-C stops accepting requests and waits for active requests to finish;
idle sockets time out after five seconds.

Use JSON bodies with `PUT /v1/kv/{key}`:

```json
{"value": {"hello": "world"}, "ttl_seconds": 60}
```

`value` can be any JSON value. Omit `ttl_seconds` for no expiration; when supplied,
it must be a finite positive number. PUT returns 201 for a new key or 200 for a
replacement, with `{"key": KEY, "value": VALUE}`. Replacement resets the TTL.
Keys must be nonempty UTF-8 strings, URL-encoded, and cannot contain `/`.

- `GET /v1/kv/{key}` returns `{"key": KEY, "value": VALUE}`, or 404.
- `DELETE /v1/kv/{key}` returns an empty 204 response, or 404.
- `GET /v1/keys` returns `{"keys": [...]}` in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Errors are JSON objects with an `error` field. Request bodies are limited to
1 MiB. PUT requires Content-Length; chunked requests are unsupported. Responses
close the connection. HEAD follows HTTP semantics and sends no response body.

Mutations are serialized and written to a flushed, fsynced temporary file in the
data directory before atomic replacement and acknowledgement. Failed writes do
not publish the mutation in memory. Expiration uses absolute wall-clock times,
so TTLs continue across restarts. Expired entries are excluded from reads and
subsequent writes. Invalid existing data causes startup to fail rather than
silently discarding it. Run only one server process per data file. This service
has no authentication; use it on a trusted network.

Run the integration and persistence tests:

```sh
python3 -m unittest discover -v
```
