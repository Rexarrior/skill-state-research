# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with TTL support and atomic
on-disk persistence.

Run it with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Port `0` asks the OS for a free port; the service prints `LISTENING <port>` as
its first stdout line. Diagnostics are written to stderr. Send values with
`PUT /v1/kv/{url-encoded-key}` and a JSON body such as
`{"value":{"answer":42},"ttl_seconds":60}`. Read or delete the same URL,
list live keys at `GET /v1/keys`, and check health at `GET /health`.

Keys are UTF-8, may contain spaces, and cannot be empty or contain `/`. Request
bodies are limited to 1 MiB. The data file is replaced atomically after each
mutation, and expired records are removed on startup and normal access.
