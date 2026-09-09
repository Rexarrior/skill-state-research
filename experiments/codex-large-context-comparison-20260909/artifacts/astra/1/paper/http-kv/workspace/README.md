# Persistent HTTP key-value service

Requires Python 3.11+; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
Use one server process per data file. SIGTERM/SIGINT stop accepting requests and
wait for active requests to finish (idle connections time out after 10 seconds).

- `PUT /v1/kv/{key}`: JSON `{"value": ANY, "ttl_seconds": 60}`; TTL is optional,
  finite and positive. Returns 201 on creation or 200 on replacement.
- `GET /v1/kv/{key}`: returns `{"key": KEY, "value": ANY}`, or 404.
- `DELETE /v1/kv/{key}`: returns 204 with no body, or 404.
- `GET /v1/keys`: returns sorted live keys as `{"keys": [...]}`.
- `GET /health`: returns `{"status":"ok"}`.

Percent-encode UTF-8 keys; empty keys and decoded slashes are rejected. Errors
are JSON. PUT bodies must contain `value` and optionally `ttl_seconds`, with no
other fields. Bodies are limited to 1 MiB; chunked requests are unsupported.

Writes are serialized and saved using a flushed, fsynced temporary file followed
by atomic replacement. The versioned JSON file stores absolute expiry times,
so expired values remain missing across restarts. Expired records are omitted
from subsequent writes. A corrupt data file causes startup to fail.

Run integration tests with `python3 -m unittest -v`.
