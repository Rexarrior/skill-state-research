# Persistent HTTP key-value service

A dependency-free Python 3.11+ HTTP service that stores JSON values in an
atomically replaced JSON file.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Using port `0` selects a free port; the server prints `LISTENING <port>` as its
first stdout line. Diagnostics go to stderr.

## API

- `PUT /v1/kv/{url-encoded-key}` — body: `{"value": <json>, "ttl_seconds": <positive number>}` (`ttl_seconds` is optional)
- `GET /v1/kv/{url-encoded-key}`
- `DELETE /v1/kv/{url-encoded-key}`
- `GET /v1/keys`
- `GET /health`

Keys may contain spaces but cannot be empty or contain `/`. Request bodies are
limited to 1 MiB. Values and unexpired TTLs survive restarts. Stop the server
with `SIGTERM` or `Ctrl-C`.

Run the self-tests with:

```sh
python3 -m unittest -v
```
