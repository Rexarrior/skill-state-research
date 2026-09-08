# Persistent HTTP key-value service

Requires Python 3.11+ and no third-party dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
SIGTERM and SIGINT stop accepting requests and wait for active handlers.

- `PUT /v1/kv/{key}`: JSON `{"value": ...}` with optional positive, finite
  `ttl_seconds`; returns 201 on creation or 200 on replacement.
- `GET /v1/kv/{key}`: returns `{"key": ..., "value": ...}` or 404.
- `DELETE /v1/kv/{key}`: returns 204 (empty body) or 404.
- `GET /v1/keys`: returns sorted live keys in `{"keys": [...]}`.
- `GET /health`: returns `{"status":"ok"}`.

Percent-encode UTF-8 keys; keys must be nonempty and cannot contain `/`.
PUT requires Content-Length and accepts at most 1 MiB. Invalid requests return
4xx JSON errors. Chunked request bodies are not supported. Responses use JSON,
except the bodyless 204 response required by HTTP.

Mutations are serialized and persisted before success using a flushed, fsynced
temporary file and atomic replacement. Expiration uses absolute Unix timestamps,
so TTL continues across restarts. Expired records are filtered on reads and
startup; listing or accessing data also prunes them from disk. Replacing without
a TTL clears any previous expiration. Use one service process per data file;
multi-process sharing is not supported. Invalid existing data fails startup
without overwriting the file.

Run integration tests:

```sh
python3 -m unittest -v
```
