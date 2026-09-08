# Persistent HTTP key-value service

Requires Python 3.11+; uses only the standard library.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./state.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}` with `{"value": ANY, "ttl_seconds": NUMBER}` creates (201) or replaces (200). TTL is optional, finite, and positive; replacing without TTL removes the old expiration.
- `GET /v1/kv/{key}` returns `{"key": KEY, "value": ANY}` or 404.
- `DELETE /v1/kv/{key}` returns 204 with no body, or 404.
- `GET /v1/keys` lists live keys in lexicographic order.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys in the URL. Empty keys and slashes are rejected.
Requests are limited to 1 MiB; chunked request bodies are unsupported. Errors
are JSON. Connections close after each response and have a five-second I/O timeout.

Mutations are serialized and acknowledged after an atomic JSON snapshot replacement.
Expiration uses absolute wall-clock timestamps and survives restarts. Expired entries
are removed on storage operations and startup. Use one server process per state file.
The file is service-managed; malformed state causes startup to fail instead of discarding data.
SIGTERM and Ctrl-C stop accepting requests and wait for active handlers.

Run the integration tests with:

```sh
python3 -m unittest -v
```
