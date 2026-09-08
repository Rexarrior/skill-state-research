# Persistent HTTP key-value service

A dependency-free Python 3.11+ service that stores JSON values in an atomically
replaced JSON data file.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to choose a free port. The service prints its selected port as
`LISTENING <port>` on stdout; request logs and diagnostics go to stderr.

## API

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"message":"hello"},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/health
```

Keys are URL-encoded UTF-8 path segments. Values may be any JSON value. A PUT
creates or replaces an entry; optional `ttl_seconds` must be a finite positive
number. Request bodies are limited to 1 MiB. Send SIGTERM or press Ctrl-C for a
clean shutdown.
