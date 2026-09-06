# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service with JSON-file persistence, optional
per-key TTLs, atomic writes, and concurrent request handling.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to choose a free port. The service prints `LISTENING <port>` to
stdout once it is ready; request logs and errors go to stderr.

## API examples

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/a%20key \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/a%20key
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/a%20key
curl http://127.0.0.1:8080/health
```

Keys are UTF-8 URL path segments: they may contain spaces but cannot be empty
or contain `/`. Request bodies are limited to 1 MiB. A `PUT` returns 201 when it
creates a live key and 200 when it replaces one; `DELETE` returns an empty 204.

## Test

```sh
python3 -m unittest -v
```
