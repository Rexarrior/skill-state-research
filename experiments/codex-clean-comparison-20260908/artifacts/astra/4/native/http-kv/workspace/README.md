# Persistent HTTP key-value service

Requires Python 3.11+ and only the standard library.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
The data file is created automatically; its parent directory must exist.

- `PUT /v1/kv/{key}`: JSON `{"value": ..., "ttl_seconds": 60}`; TTL is optional.
  Returns 201 on creation, 200 on replacement, with `{"key": ..., "value": ...}`.
- `GET /v1/kv/{key}`: returns the key and value, or 404.
- `DELETE /v1/kv/{key}`: returns 204 with no body, or 404.
- `GET /v1/keys`: returns `{"keys": [...]}` sorted lexicographically.
- `GET /health`: returns `{"status":"ok"}`.

Percent-encode UTF-8 keys in URLs. Keys must be nonempty and cannot contain `/`.
Values may be any JSON value. TTL must be a finite positive number; expiration
uses absolute Unix timestamps and continues while the service is stopped.
Replacing a value without a TTL removes its previous expiration.

Requests are limited to 1 MiB and must use Content-Length when sending a body;
chunked transfer encoding is unsupported. Errors have a JSON `error` field.
HTTP connections close after each response. Unknown methods return 405 on known
routes; unknown routes return 404.

Writes are serialized under a lock and flushed to a temporary file before atomic
replacement of the data file. Failed writes do not update memory. Restarting
loads the stored state and discards expired entries. A corrupt data file causes
startup to fail instead of silently losing data. Run only one service process per
data file. SIGTERM and SIGINT stop accepting connections and wait for active
requests; idle request sockets have a five-second timeout.

Run the integration tests with:

```sh
python3 -m unittest discover -v
```
