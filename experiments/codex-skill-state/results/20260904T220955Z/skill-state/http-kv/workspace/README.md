# Persistent HTTP key-value service

Dependency-free Python 3.11+ service with JSON persistence and TTL support.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

With `--port 0`, the first stdout line is `LISTENING <port>`. Diagnostics are
written to stderr. The API provides `PUT`, `GET`, and `DELETE /v1/kv/{key}`;
`GET /v1/keys`; and `GET /health`. Keys must be URL encoded. State is atomically
written to the data file after changes; expired values are removed.

Run built-in checks with:

```sh
python3 server.py --host 127.0.0.1 --port 0 --data /tmp/unused.json --self-test
```
