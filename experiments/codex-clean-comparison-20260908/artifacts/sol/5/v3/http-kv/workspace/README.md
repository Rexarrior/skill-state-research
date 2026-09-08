# Persistent HTTP key-value service

This dependency-free Python 3.11+ service stores arbitrary JSON values in an
atomically replaced JSON file.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to select a free port; the service prints `LISTENING <port>` as its
first stdout line. Keys in `/v1/kv/{key}` must be URL encoded. The API supports
`PUT` and `GET` on individual keys, `DELETE` on individual keys,
`GET /v1/keys`, and `GET /health`. A PUT body has the form
`{"value": <any JSON value>, "ttl_seconds": <optional positive number>}`.

Run the end-to-end self-tests with:

```sh
python3 -m unittest -v
```

SIGTERM and Ctrl-C trigger a clean shutdown. Request diagnostics are written to
stderr; stdout is reserved for the listening announcement.
