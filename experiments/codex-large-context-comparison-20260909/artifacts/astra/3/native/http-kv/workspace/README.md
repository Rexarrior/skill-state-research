# Persistent HTTP key-value service

Requires Python 3.11 or newer; no third-party dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Port `0` selects a free
port. Request logs and diagnostics go to stderr. SIGTERM and Ctrl-C stop the
listener and wait for active requests; idle connections time out after 5 seconds.

Use JSON request bodies:

```sh
curl -X PUT http://127.0.0.1:PORT/v1/kv/hello%20world \
  -H 'Content-Type: application/json' \
  -d '{"value":{"message":"hello"},"ttl_seconds":60}'
curl http://127.0.0.1:PORT/v1/kv/hello%20world
curl http://127.0.0.1:PORT/v1/keys
curl -X DELETE http://127.0.0.1:PORT/v1/kv/hello%20world
curl http://127.0.0.1:PORT/health
```

PUT returns 201 on creation and 200 on replacement, with `{"key":...,"value":...}`.
GET returns the same object or 404. DELETE returns 204 with no body, or 404.
The keys endpoint returns `{"keys":[...]}` in lexicographic order; health returns
`{"status":"ok"}`. Errors are JSON objects with an `error` field.

Keys must be nonempty UTF-8 without slashes; percent-encode special characters.
Values can be any JSON value. Optional TTLs must be finite positive numbers
(not booleans); omitting the TTL on replacement removes the old expiration.
Bodies are limited to 1 MiB. Requests use Content-Length; chunked request bodies
are rejected. Responses close the connection. Unsupported methods return 405.

Mutations are serialized and acknowledged after writing and fsyncing a temporary
JSON file and atomically replacing the data file. The file contains versioned
entries with absolute expiration timestamps, so expired values stay missing
across restarts. Expired records are pruned from disk on startup and subsequent
mutations. Invalid existing data causes startup to fail. Run only one server
process per data file; synchronization covers threads within that process.

Run the integration and persistence tests:

```sh
python3 -m unittest -v
```
