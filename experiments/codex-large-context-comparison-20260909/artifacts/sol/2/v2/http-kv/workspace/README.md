# Persistent HTTP key-value service

This project is a dependency-free Python 3.11+ JSON HTTP service whose values are
stored atomically on disk.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to have the operating system select a free port. The service prints
`LISTENING <port>` to stdout when it is ready; request logs and diagnostics go to
stderr.

## API

- `PUT /v1/kv/<URL-encoded-key>` with `{"value": <any JSON>, "ttl_seconds": 30}`
- `GET /v1/kv/<URL-encoded-key>`
- `DELETE /v1/kv/<URL-encoded-key>`
- `GET /v1/keys`
- `GET /health`

Keys must be non-empty UTF-8 strings without `/`. `ttl_seconds` is optional and,
when supplied, must be a finite positive number. Request bodies are limited to 1
MiB. Live values are committed using a temporary file plus atomic replacement,
and expired values are removed from durable state.

Run the self-tests with:

```sh
python3 -m unittest -v
```
