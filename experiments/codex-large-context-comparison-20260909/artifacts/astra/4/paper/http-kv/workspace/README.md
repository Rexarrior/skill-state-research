# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}`: JSON `{"value": ANY, "ttl_seconds": NUMBER?}`; returns 201 on creation or 200 on replacement, with the key and value.
- `GET /v1/kv/{key}`: returns the key and value, or 404.
- `DELETE /v1/kv/{key}`: returns 204 with no body, or 404.
- `GET /v1/keys`: returns `{"keys": [...]}` in sorted order.
- `GET /health`: returns `{"status":"ok"}`.

URL-encode keys as UTF-8. Empty keys and slashes are invalid. TTL must be a finite positive number; replacing without TTL removes any old expiration. PUT bodies are limited to 1 MiB. Errors are JSON. Chunked requests are not supported; send Content-Length.

State is stored as JSON using flushed, fsynced temporary files and atomic replacement. Requests synchronize access within one server process. Use one process per data file. Expiration uses absolute wall-clock timestamps, so restart downtime counts toward TTL. Expired entries are removed on access and startup. Invalid existing state causes startup to fail instead of overwriting it. SIGTERM/SIGINT stop acceptance and wait for active handlers (socket inactivity timeout: 10 seconds).

Run integration tests:

```sh
python3 -m unittest -v
```
