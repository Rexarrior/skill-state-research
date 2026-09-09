# Persistent HTTP key-value service

This repository contains a dependency-free Python 3.11+ JSON HTTP service with
atomic file persistence, optional per-key TTLs, and thread-safe request handling.

Start it with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Using port `0` selects an available port; the server prints `LISTENING <port>`
as its first stdout line. Diagnostics go to stderr. Stop the process with
SIGINT or SIGTERM for a clean shutdown.

Examples:

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"hello":"world"},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/example
```

Request bodies are limited to 1 MiB. Keys must be URL-encoded UTF-8, non-empty,
and may not contain `/` (including an encoded slash).

Run the self-tests with:

```sh
python3 -m unittest -v
```
