# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service that stores JSON values in an
atomically replaced JSON data file.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Port `0` asks the operating system for a free port. The service prints
`LISTENING <port>` as its first stdout line; request diagnostics go to stderr.

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

Keys are UTF-8 URL-encoded path segments. They may contain spaces but cannot
be empty or contain `/`. PUT accepts any JSON value in the required `value`
field and an optional positive finite `ttl_seconds`. Request bodies are limited
to 1 MiB. Live values survive restarts; expired values are removed.
