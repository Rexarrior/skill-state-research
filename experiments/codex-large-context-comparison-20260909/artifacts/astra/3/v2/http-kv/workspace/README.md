# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
SIGTERM or Ctrl-C stops the server and waits for active requests.

- `PUT /v1/kv/{key}`: JSON `{"value": ...}` with optional positive, finite
  `"ttl_seconds"`. Returns 201 on creation, 200 on replacement.
- `GET /v1/kv/{key}`: returns `{"key": ..., "value": ...}` or 404.
- `DELETE /v1/kv/{key}`: returns 204 (empty body) or 404.
- `GET /v1/keys`: returns `{"keys": [...]}` in lexicographic order.
- `GET /health`: returns `{"status": "ok"}`.

Percent-encode UTF-8 keys; spaces are allowed, empty keys and slashes are not.
Errors are JSON objects with an `error` field. PUT requires Content-Length;
request bodies are limited to 1 MiB. Chunked requests are unsupported.

Writes are serialized and saved using a flushed, fsynced temporary file and
atomic replacement before success is returned. The versioned JSON file stores
absolute expiration timestamps; downtime counts toward TTL. Expired records
are removed on store access, startup, and clean shutdown. Use one server process
per data file. The service has no authentication; bind to a trusted interface.

Run the integration tests:

```sh
python3 -m unittest -v
```
