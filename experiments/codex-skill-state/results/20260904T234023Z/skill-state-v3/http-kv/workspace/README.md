# Persistent HTTP key-value service

Dependency-free Python 3.11+ JSON key-value server with atomic on-disk persistence and optional per-value TTLs.

Run it with:

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./kv-data.json
```

The first stdout line reports `LISTENING <port>`. Diagnostics are written to stderr.

The API offers `PUT`, `GET`, and `DELETE /v1/kv/{url-encoded-key}`, `GET /v1/keys`, and `GET /health`. PUT accepts `{"value": any-json, "ttl_seconds": positive-number}`. Entries are atomically persisted to the data path and expired entries are removed.

Run the integration tests:

```sh
python3 -m unittest -v test_server.py
```
