# Persistent HTTP key-value service

This project is a dependency-free Python 3.11+ HTTP service with JSON-file
persistence, optional TTLs, atomic updates, and thread-safe request handling.

Start it with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints exactly one startup
line to stdout, `LISTENING <port>`; request logs and diagnostics go to stderr.

Example:

```sh
curl -X PUT -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}' \
  http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/example
```

The data file is an implementation-owned JSON document and should not be
edited while the service is running. Each mutation is written to a temporary
file, flushed, and atomically moved into place. An unreadable or invalid data
file causes startup to fail rather than silently discarding data.

Run the self-tests with:

```sh
python3 -m unittest -v
```
