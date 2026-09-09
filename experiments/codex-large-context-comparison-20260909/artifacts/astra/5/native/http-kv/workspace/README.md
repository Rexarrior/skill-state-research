# Persistent HTTP key-value service

Requires Python 3.11 or newer; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
Send SIGTERM or Ctrl-C to stop accepting requests and finish active requests.

Endpoints:

- `PUT /v1/kv/{key}` with `{"value": <JSON>, "ttl_seconds": <optional positive number>}` returns 201 for creation or 200 for replacement, with the key and value.
- `GET /v1/kv/{key}` returns `{"key": ..., "value": ...}` or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` returns `{"keys": [...]}` in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode keys as UTF-8 URL path segments. Empty keys and decoded slashes
are invalid; spaces are allowed. PUT replaces the entire entry, including its
TTL; omitting TTL makes the replacement permanent. Expiry uses wall-clock time
and continues while the service is stopped.

Requests with bodies require Content-Length and UTF-8 JSON. Bodies are limited
to 1 MiB; chunked transfer encoding is unsupported. Invalid requests return JSON
errors. Each connection closes after its response. DELETE's 204 response has no
body, as required by HTTP.

Mutations are serialized and saved before success is returned, using a synced
temporary file and atomic replacement in the data directory. The versioned JSON
file stores values and absolute expiry timestamps. Expired entries are ignored
on every read and restart, and removed from disk on the next successful mutation.
An invalid existing data file prevents startup. Use one server process per data
file; cross-process writers are not supported.

Run the integration and storage tests:

```sh
python3 -m unittest discover -v
```
