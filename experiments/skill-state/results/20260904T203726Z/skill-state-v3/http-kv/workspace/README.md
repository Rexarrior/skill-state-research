# Persistent HTTP key-value service

Dependency-free Python 3.11+ HTTP key-value service with optional TTL and atomic JSON persistence.

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use `--port 0` to select a free port; the first stdout line is `LISTENING <port>`.

```sh
curl -X PUT http://127.0.0.1:8080/v1/kv/hello \
  -H 'Content-Type: application/json' -d '{"value":{"message":"world"}}'
curl http://127.0.0.1:8080/v1/kv/hello
curl http://127.0.0.1:8080/v1/keys
```

Run the self-tests with `python3 test_server.py`.
