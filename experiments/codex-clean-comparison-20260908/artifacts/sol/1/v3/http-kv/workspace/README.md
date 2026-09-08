# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service that stores arbitrary JSON values in
an atomically replaced JSON data file.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./store.json
```

Use `--port 0` to select an available port. The first stdout line reports it as
`LISTENING <port>`. Request diagnostics are written to stderr.

## API

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/greeting \
  -H 'Content-Type: application/json' \
  --data '{"value":"hello","ttl_seconds":60}'
curl -i http://127.0.0.1:8080/v1/kv/greeting
curl -i http://127.0.0.1:8080/v1/keys
curl -i -X DELETE http://127.0.0.1:8080/v1/kv/greeting
curl -i http://127.0.0.1:8080/health
```

Keys are UTF-8 URL path segments. They may contain spaces (normally encoded as
`%20`) but cannot be empty or contain `/`. PUT accepts an object containing
`value` and an optional positive, finite `ttl_seconds`. Request bodies are
limited to 1 MiB. Live state is persisted after every mutation; TTL deadlines
are absolute, so expired values stay expired across restarts.
