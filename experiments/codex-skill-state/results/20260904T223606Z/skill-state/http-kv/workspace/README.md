# Persistent HTTP key-value service

Dependency-free Python 3.11+ JSON key-value HTTP service with atomic JSON-file persistence and optional TTLs.

Run it with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./kv.json
```

Using `--port 0` chooses a free port and prints `LISTENING <port>` as the first stdout line. The API provides `PUT`, `GET`, and `DELETE` at `/v1/kv/{url-encoded-key}`, `GET /v1/keys`, and `GET /health`.

Run the included checks:

```sh
python3 server.py --self-test
```
