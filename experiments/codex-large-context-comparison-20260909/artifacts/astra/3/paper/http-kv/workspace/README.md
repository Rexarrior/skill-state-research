# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
Use one server process per data file. SIGTERM and Ctrl-C stop the listener and
wait for active requests (socket operations have a five-second timeout).

- `PUT /v1/kv/{key}`: JSON `{"value": <any JSON>, "ttl_seconds": <optional positive number>}`; returns 201 on creation or 200 on replacement.
- `GET /v1/kv/{key}`: returns `{"key": ..., "value": ...}` or 404.
- `DELETE /v1/kv/{key}`: returns 204 with no body, or 404.
- `GET /v1/keys`: returns `{"keys": [...]}` sorted lexicographically.
- `GET /health`: returns `{"status":"ok"}`.

URL-encode UTF-8 keys; spaces are allowed, empty keys and slashes are not.
PUT requires Content-Length and has a 1 MiB body limit. Chunked requests are
unsupported. Errors have JSON bodies. TTL is measured in wall-clock seconds;
replacing a value without TTL removes its expiry.

Mutations are serialized and saved with a flushed, fsynced temporary file and
atomic replacement before success is returned. Expiry timestamps survive
restarts; expired records are filtered on startup and access. The data file is
a versioned JSON object; invalid existing data causes startup to fail.

Run the integration tests with `python3 -m unittest -v`.
