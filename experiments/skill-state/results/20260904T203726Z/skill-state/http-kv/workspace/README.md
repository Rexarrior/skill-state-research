# Persistent HTTP key-value service

Run with Python 3.11 or newer:

```sh
python3 server.py --host 127.0.0.1 --port 0 --data ./kv.json
```

The first stdout line reports the chosen port as `LISTENING <port>`. All API
responses are JSON, except successful `DELETE` responses, which are empty with
status 204.

```sh
curl -X PUT http://127.0.0.1:PORT/v1/kv/hello%20world \
  -H 'Content-Type: application/json' -d '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:PORT/v1/kv/hello%20world
curl http://127.0.0.1:PORT/v1/keys
curl -X DELETE http://127.0.0.1:PORT/v1/kv/hello%20world
curl http://127.0.0.1:PORT/health
```

Values are persisted atomically in the JSON file supplied through `--data`.
Expired values are removed before reads, listings, writes, and when loading
persisted state after a restart.
