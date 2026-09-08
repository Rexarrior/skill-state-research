# Persistent HTTP key-value service

This project is a dependency-free Python 3.11+ HTTP service with JSON-file
persistence, optional TTLs, concurrent request handling, and clean SIGTERM
shutdown.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to choose an available port. The first stdout line reports it as
`LISTENING <port>`; request logs and diagnostics go to stderr.

## API examples

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl -i http://127.0.0.1:8080/v1/kv/example
curl -i http://127.0.0.1:8080/v1/keys
curl -i -X DELETE http://127.0.0.1:8080/v1/kv/example
curl -i http://127.0.0.1:8080/health
```

Keys are UTF-8 URL path components. Percent-encode spaces and other reserved
characters; keys may not be empty or contain `/`. PUT bodies must contain
`value` and may contain a finite, positive `ttl_seconds`. Request bodies are
limited to 1 MiB.

## Quick checks

Syntax-check the implementation with:

```sh
python3 -m py_compile server.py
```

For an end-to-end smoke test, start the server with a temporary data path, run
the example requests above, send it SIGTERM, restart it with the same path, and
confirm unexpired values remain available.
