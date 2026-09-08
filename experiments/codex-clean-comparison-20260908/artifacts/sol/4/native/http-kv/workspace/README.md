# Persistent HTTP key-value service

This is a dependency-free Python 3.11+ HTTP service with JSON values, optional
TTLs, concurrent request handling, and atomic on-disk persistence.

Start it with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Using `--port 0` selects a free port; the service prints `LISTENING <port>` as
its first stdout line. Diagnostics go to stderr. Stop it with SIGINT or SIGTERM.

Examples:

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/example
```

Run the self-tests with:

```sh
python3 -m unittest -v
```
