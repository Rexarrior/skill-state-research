# Persistent HTTP key-value service

Requires Python 3.11 or newer; no third-party dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./data.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
Use a fixed port instead of `0` to select it explicitly.

- `PUT /v1/kv/{key}`: JSON `{"value": any JSON value, "ttl_seconds": optional positive number}`. Returns 201 for creation or 200 for replacement, with the key and value.
- `GET /v1/kv/{key}`: returns `{"key": ..., "value": ...}` or 404.
- `DELETE /v1/kv/{key}`: returns 204 (no body) or 404.
- `GET /v1/keys`: returns `{"keys": [...]}` sorted lexicographically.
- `GET /health`: returns `{"status":"ok"}`.

Percent-encode UTF-8 keys in URLs. Empty keys and keys containing `/` are
invalid. PUT requires Content-Length and accepts at most 1 MiB. Errors have
JSON bodies. TTL must be finite and greater than zero; omitting it on a
replacement removes the previous TTL. Expired keys count as missing.

Mutations are serialized and saved using a flushed, fsynced temporary file
and atomic replacement in the data directory before success is returned.
Expiration uses absolute wall-clock timestamps and survives restarts. Invalid
existing snapshots cause startup to fail without overwriting the file. Run
only one server process per data file. SIGTERM/SIGINT stop accepting requests
and wait for active handlers (connections have a 10-second timeout).

Run integration tests with:

```sh
python3 -m unittest -v
```
