# Persistent HTTP key-value service

This repository contains a dependency-free Python 3.11+ HTTP JSON service with
thread-safe access, optional TTLs, and atomic on-disk persistence.

Start it with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Port `0` chooses a free port. The process prints `LISTENING <port>` to stdout
once it is ready; request logs and errors go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` accepts `{"value": ..., "ttl_seconds": 30}`.
- `GET /v1/kv/{url-encoded-key}` fetches a live entry.
- `DELETE /v1/kv/{url-encoded-key}` removes an entry.
- `GET /v1/keys` lists live keys in lexical order.
- `GET /health` reports service health.

All request and response bodies use JSON. PUT requests must include
`Content-Type: application/json`; bodies larger than 1 MiB are rejected.
Send `SIGTERM` (or press Ctrl-C) for a clean shutdown.
