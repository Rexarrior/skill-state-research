# Persistent HTTP key-value service

Requires Python 3.11 or newer and has no third-party dependencies.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./state.json
```

Use `--port 0` to select an available port. The first stdout line is `LISTENING <port>`.
All endpoints use JSON:

```sh
curl -X PUT localhost:8080/v1/kv/example -H 'Content-Type: application/json' -d '{"value":{"hello":"world"},"ttl_seconds":60}'
curl localhost:8080/v1/kv/example
curl localhost:8080/v1/keys
curl -X DELETE localhost:8080/v1/kv/example
curl localhost:8080/health
```

Entries are atomically persisted to the data file. Run the integration tests with:

```sh
python3 -m unittest -v test_server.py
```
