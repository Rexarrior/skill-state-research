# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON service with TTLs, concurrent request handling,
and atomic on-disk persistence.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select a free port; the service prints `LISTENING <port>` as its
first stdout line. Diagnostics go to stderr. Stop it with `SIGTERM` or Ctrl-C.

## API

- `PUT /v1/kv/{url-encoded-key}` — body `{"value": <json>, "ttl_seconds": <positive-number>}`;
  the TTL is optional. Returns 201 for a new key and 200 for a replacement.
- `GET /v1/kv/{url-encoded-key}` — fetch a live value.
- `DELETE /v1/kv/{url-encoded-key}` — delete it (204) or return 404.
- `GET /v1/keys` — list live keys in lexicographic order.
- `GET /health` — health check.

All response bodies are JSON; errors have an `error` field. Request bodies are
limited to 1 MiB.

Run the black-box tests with:

```sh
python3 -m unittest -v test_server.py
```
