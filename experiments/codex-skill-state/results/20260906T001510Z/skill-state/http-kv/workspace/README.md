# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON HTTP service with TTL support and atomic
on-disk persistence.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port. The service prints only
`LISTENING <port>` to stdout when ready; request diagnostics go to stderr.

## API

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/example \
  -H 'Content-Type: application/json' \
  --data '{"value":{"message":"hello"},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/v1/keys
curl -i -X DELETE http://127.0.0.1:8080/v1/kv/example
curl http://127.0.0.1:8080/health
```

Keys are URL-encoded UTF-8 strings and cannot be empty or contain `/`. PUT
bodies must contain `value` and may contain a finite, positive `ttl_seconds`.
Requests are limited to 1 MiB. Live values are written to the selected data
file using atomic replacement and are restored after restart.

## Self-check

Start the service with `--port 0`, use the printed port in the commands above,
then terminate it with `SIGTERM` and restart it with the same data path to
verify persistence.
