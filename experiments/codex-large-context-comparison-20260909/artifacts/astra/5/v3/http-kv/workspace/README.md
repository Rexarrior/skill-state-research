# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}` with `{"value": any JSON value, "ttl_seconds": optional positive number}` returns 201 for creation or 200 for replacement.
- `GET /v1/kv/{key}` returns `{"key": key, "value": value}` or 404.
- `DELETE /v1/kv/{key}` returns 204 (empty body) or 404.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode keys as UTF-8 path segments. Empty keys and slashes are invalid. Request bodies are limited to 1 MiB. Errors are JSON. Requests use Content-Length; chunked request bodies are unsupported.

Writes atomically replace the JSON data file before responding. Expiration uses absolute wall-clock timestamps and survives restarts. Expired values are excluded from reads and removed from the file on the next store operation or startup. Replacing a value without a TTL removes its previous expiration. A lock serializes concurrent store operations. Run only one server process per data file. SIGTERM and SIGINT stop accepting requests and wait for active handlers (socket timeout: 10 seconds). Invalid existing data causes startup to fail rather than discarding it.

Run the integration tests:

```sh
python3 -m unittest -v
```
