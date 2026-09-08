# Persistent HTTP key-value service

Requires Python 3.11 or newer; no dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./state.json
```

The first stdout line is `LISTENING <actual-port>`. Diagnostics go to stderr.
SIGTERM and Ctrl-C stop accepting requests and wait for active requests to finish.

- `PUT /v1/kv/{key}`: JSON `{"value": ANY, "ttl_seconds": NUMBER?}`;
  returns 201 for creation, 200 for replacement, with `{"key": KEY, "value": ANY}`.
- `GET /v1/kv/{key}`: returns the key and value, or 404.
- `DELETE /v1/kv/{key}`: returns 204 with no body, or 404.
- `GET /v1/keys`: returns `{"keys": [...]}` in lexicographic order.
- `GET /health`: returns `{"status":"ok"}`.

Percent-encode UTF-8 keys in URLs. Empty keys and keys containing `/` are invalid.
TTL must be a finite positive JSON number. Replacing a value without a TTL removes
its previous expiration. Expired keys behave as missing, including after restart.
Errors have JSON bodies. Request bodies are limited to 1 MiB and PUT requires
Content-Length; chunked transfer encoding is unsupported. Each connection closes
after its response. Incomplete requests time out after 10 seconds of inactivity.

Writes are serialized and saved before success is returned, using a flushed,
fsynced temporary file and atomic replacement in the data file's directory.
The file stores values and absolute expiration timestamps. Expired records are
discarded at startup and on subsequent writes. Invalid existing state fails startup
without overwriting the file. Use one server process per data file; coordination
between separate processes is not supported.

Run the integration and persistence tests:

```sh
python3 -m unittest -v
```
