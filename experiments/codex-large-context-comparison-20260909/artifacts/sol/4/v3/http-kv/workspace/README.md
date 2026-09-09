# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON API with atomic on-disk persistence, optional
per-key TTLs, concurrent request handling, and clean SIGTERM shutdown.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Using `--port 0` selects a free port; the service prints `LISTENING <port>` as
its first stdout line. Diagnostics and request logs go to stderr.

## API

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  -d '{"value":{"message":"hello"},"ttl_seconds":60}'
curl -i http://127.0.0.1:8080/v1/kv/example
curl -i http://127.0.0.1:8080/v1/keys
curl -i -X DELETE http://127.0.0.1:8080/v1/kv/example
curl -i http://127.0.0.1:8080/health
```

Keys are UTF-8 URL path segments. They may contain spaces but cannot be empty or
contain `/` (including an encoded slash). PUT request bodies are limited to 1 MiB.
The data file's parent directory is created when necessary, and updates use an
fsynced temporary file followed by atomic replacement.
