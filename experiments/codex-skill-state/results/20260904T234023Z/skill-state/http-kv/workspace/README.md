# Persistent HTTP key-value service

Dependency-free Python 3.11+ service with JSON persistence and TTL support.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./kv.json
```

With `--port 0`, the first stdout line is `LISTENING <actual-port>`. Diagnostics
are written to stderr. Data is atomically replaced after every mutation.

Endpoints:

- `PUT /v1/kv/{url-encoded-key}`: `{"value": ANY, "ttl_seconds": NUMBER?}`
- `GET /v1/kv/{url-encoded-key}` and `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

All non-204 responses are JSON. Request bodies are limited to 1 MiB. For a
quick manual check, start the service then run:

```sh
curl -X PUT localhost:8080/v1/kv/example -H 'Content-Type: application/json' -d '{"value":{"works":true}}'
curl localhost:8080/v1/kv/example
```
