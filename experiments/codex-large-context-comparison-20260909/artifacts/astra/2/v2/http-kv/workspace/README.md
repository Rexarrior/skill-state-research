# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
Use the printed port in these requests:

```sh
curl -X PUT http://127.0.0.1:PORT/v1/kv/hello%20world \
  -H 'Content-Type: application/json' -d '{"value":{"message":"hello"},"ttl_seconds":60}'
curl http://127.0.0.1:PORT/v1/kv/hello%20world
curl http://127.0.0.1:PORT/v1/keys
curl -X DELETE http://127.0.0.1:PORT/v1/kv/hello%20world
curl http://127.0.0.1:PORT/health
```

PUT accepts a JSON object with required `value` (any JSON value) and optional
positive, finite `ttl_seconds`. It returns 201 on creation or 200 on replacement.
Omitting TTL on replacement removes the previous expiration. GET returns
`{"key":KEY,"value":VALUE}`; missing or expired keys return 404. DELETE returns
204 with no body on success. Key listing returns sorted live keys. Keys must be
nonempty UTF-8 and cannot contain `/`, including percent-encoded slashes.
Invalid input returns a JSON error. Request bodies are limited to 1 MiB;
PUT bodies use Content-Length (chunked transfer is unsupported).

Mutations are serialized and saved before success is returned, using a flushed,
fsynced temporary file and atomic replacement in the data directory. Expiration
uses absolute wall-clock timestamps and survives restarts. Expired entries are
removed during store operations and startup. An invalid existing data file
causes startup to fail rather than overwriting it. Use one server process per
data file. SIGTERM/SIGINT stops accepting requests and waits for active handlers;
idle socket reads time out after 10 seconds.

Run the integration tests with:

```sh
python3 -m unittest -v
```
