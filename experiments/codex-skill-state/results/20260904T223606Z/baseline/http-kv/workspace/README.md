# Persistent HTTP key-value service

Dependency-free Python 3.11+ HTTP service with durable JSON storage.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

With `--port 0`, the first line on standard output is `LISTENING <port>`; all
diagnostics go to standard error. Data is atomically replaced after every
mutation. Entries with a positive, finite `ttl_seconds` expire automatically.

## API examples

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/hello%20world \
  -H 'Content-Type: application/json' -d '{"value":{"answer":42}}'
curl http://127.0.0.1:8080/v1/kv/hello%20world
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/hello%20world
```

Responses are JSON (apart from the empty `204` response). Keys are UTF-8 URL
path segments: empty keys and keys containing `/` are rejected. Request bodies
are limited to 1 MiB.

Run the integration tests with:

```sh
python3 -m unittest -v test_server.py
```
