# Persistent HTTP key-value service

A dependency-free Python 3.11+ JSON API with atomic on-disk persistence and
optional per-key expiry.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select a free port; the service prints `LISTENING <port>` as
its first stdout line. Values are written with `PUT /v1/kv/{url-encoded-key}`
using `{"value": ..., "ttl_seconds": ...}`. Read and delete them with `GET`
and `DELETE` on the same URL, list live keys with `GET /v1/keys`, and check
the service with `GET /health`. Request bodies must be JSON and are limited to
1 MiB. Send `SIGTERM` or press Ctrl-C for a clean shutdown.

Run the black-box self-tests with `python3 -m unittest -v`.
