# Persistent HTTP key-value service

Requires Python 3.11 or newer; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.

- `PUT /v1/kv/{key}` accepts `{"value": <any JSON>, "ttl_seconds": <optional positive finite number>}`; returns 201 when created and 200 when replaced, with the key and value.
- `GET /v1/kv/{key}` returns the key and value, or 404.
- `DELETE /v1/kv/{key}` returns an empty 204, or 404.
- `GET /v1/keys` returns sorted live keys.
- `GET /health` returns `{"status":"ok"}`.

Percent-encode UTF-8 keys in URLs. Keys cannot be empty or contain `/`.
Requests are limited to 1 MiB. Invalid requests produce JSON errors.
Replacing a value without a TTL removes its previous expiry. TTLs use wall-clock
expiry times and remain effective across restarts.

Each successful mutation atomically replaces the JSON snapshot after flushing it
to disk. Concurrent requests are serialized around storage operations. Expired
entries are filtered on every read and removed from snapshots on writes, startup,
and shutdown. Use one service process per data file. SIGTERM and SIGINT stop
accepting requests, wait for active handlers, and persist live entries. Incomplete
clients have a 10-second socket timeout.

Run the integration tests:

```sh
python3 -m unittest -v
```
