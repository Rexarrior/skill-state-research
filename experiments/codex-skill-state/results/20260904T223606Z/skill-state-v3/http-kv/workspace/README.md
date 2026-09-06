# Persistent HTTP key-value service

Dependency-free Python 3.11+ HTTP service with atomic JSON persistence and optional TTLs.

Run it with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

When `--port 0` is used, the first stdout line is `LISTENING <port>`.

Examples:

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/hello \
  -H 'Content-Type: application/json' -d '{"value":{"message":"world"}}'
curl http://127.0.0.1:8080/v1/kv/hello
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/hello
```

`PUT /v1/kv/{url-encoded-key}` accepts `{"value": any, "ttl_seconds": positive-finite-number?}`.
`GET /health`, `GET /v1/keys`, `GET /v1/kv/{key}`, and `DELETE /v1/kv/{key}` provide the remaining API.
All non-empty responses are JSON; request bodies are limited to 1 MiB. The data file is atomically replaced after each mutation.
