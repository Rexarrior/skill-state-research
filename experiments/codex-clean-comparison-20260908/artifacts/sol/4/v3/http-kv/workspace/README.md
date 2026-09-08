# Persistent HTTP key-value service

This dependency-free Python 3.11+ service stores arbitrary JSON values in an
atomically replaced JSON file. Requests are handled concurrently, and optional
TTLs use wall-clock seconds.

Start the server with:

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Using `--port 0` selects a free port. The first stdout line reports it as
`LISTENING <port>`; request diagnostics go to stderr.

The API provides `GET /health`, `GET /v1/keys`, and `GET`, `PUT`, and `DELETE`
on `/v1/kv/{url-encoded-key}`. A PUT body has the form
`{"value": <any JSON value>, "ttl_seconds": <optional positive finite number>}`.
Keys may contain spaces but not slashes. Request bodies are limited to 1 MiB.

Run the integration tests with:

```sh
python3 -m unittest -v
```
