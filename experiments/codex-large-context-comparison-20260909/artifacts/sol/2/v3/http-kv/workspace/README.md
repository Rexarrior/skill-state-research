# Persistent HTTP key-value service

This dependency-free Python 3.11+ service stores JSON values in an atomically
replaced JSON file.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./store.json
```

Use port `0` to select a free port; the service prints `LISTENING <port>` as its
first stdout line. Diagnostics go to stderr. The API provides `PUT`, `GET`, and
`DELETE /v1/kv/{url-encoded-key}`, `GET /v1/keys`, and `GET /health`. PUT bodies
have the form `{"value": <json>, "ttl_seconds": <positive-number>}`; TTL is
optional. Request bodies are limited to 1 MiB.

Run the self-tests with:

```sh
python3 -m unittest -v
```
