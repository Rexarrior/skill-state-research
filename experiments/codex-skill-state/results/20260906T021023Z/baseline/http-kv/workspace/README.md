# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with optional per-key TTL and
atomic on-disk persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Port `0` asks the OS for a free port; the service prints `LISTENING <port>` as
its first stdout line. Diagnostics are written to stderr. Stop it with SIGTERM
or Ctrl-C.

## API

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/my%20key \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/my%20key
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/my%20key
curl http://127.0.0.1:8080/health
```

Keys must be non-empty UTF-8 strings without `/`. Request bodies are limited
to 1 MiB. The data directory is created automatically.

## Test

```sh
python3 -m unittest -v
```
