# Persistent HTTP key-value service

Requires Python 3.11 or newer; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select an available port. The first stdout line is
`LISTENING <actual-port>`. Request logs and startup errors go to stderr.

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/hello%20world \
  -d '{"value":{"message":"hello"},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/hello%20world
curl http://127.0.0.1:8080/v1/keys
curl -X DELETE http://127.0.0.1:8080/v1/kv/hello%20world
curl http://127.0.0.1:8080/health
```

PUT accepts a JSON object with `value` and optional positive, finite
`ttl_seconds`. It returns 201 on creation or 200 on replacement, with the key
and value. Omitting TTL on replacement removes any prior expiration.
GET returns the key and value, or 404. DELETE returns an empty 204 response,
or 404. `/v1/keys` lists live keys in lexicographic order. `/health` returns
`{"status":"ok"}`. Keys must be nonempty, UTF-8 URL encoded, and contain no
slash. Errors are JSON objects with an `error` field. Bodies are limited to
1 MiB; chunked request bodies are unsupported. Connections close after each
response, and idle request reads time out after five seconds.

Writes serialize under a lock and persist through a flushed, fsynced temporary
file followed by atomic replacement. Expirations use absolute Unix timestamps
and survive restarts. Expired records are removed at startup and when the store
is accessed. A malformed existing data file causes startup to fail. Use one
server process per data file; sharing a file between processes is unsupported.
SIGTERM and Ctrl-C stop accepting requests and wait for active handlers.

Run the end-to-end tests (including concurrent writes and process restarts):

```sh
python3 -m unittest -v
```
