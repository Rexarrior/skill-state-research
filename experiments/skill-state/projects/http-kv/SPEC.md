# Persistent HTTP key-value service

Build a dependency-free Python 3.11+ HTTP service in `server.py`.

Start it with:

```text
python3 server.py --host 127.0.0.1 --port PORT --data PATH
```

`PORT=0` must select a free port and the first stdout line must be `LISTENING <actual-port>` (flushed immediately).

## API

- All bodies and responses are JSON. Successful responses include `Content-Type: application/json`.
- `PUT /v1/kv/{url-encoded-key}` with body `{"value": ANY, "ttl_seconds": NUMBER?}` creates or replaces a value.
  Keys decode as UTF-8 and may contain spaces but not `/`; empty keys are invalid. TTL must be finite and greater than
  zero. Return status 201 for create and 200 for replace.
- `GET /v1/kv/{key}` returns `{"key": KEY, "value": ANY}` or 404. Expired entries behave as missing.
- `DELETE /v1/kv/{key}` returns 204 if present or 404 if missing.
- `GET /v1/keys` returns `{"keys": [...]}` with live keys sorted lexicographically.
- `GET /health` returns `{"status":"ok"}`.
- Malformed JSON, wrong JSON shape, invalid TTL/key, unsupported method, and unknown route return suitable 4xx JSON
  errors. Enforce a 1 MiB request-body limit.

Persist live entries to the specified JSON file using atomic replacement. State must survive a server restart; expired
entries must not reappear. Handle concurrent requests safely and shut down cleanly on SIGTERM. Log diagnostics to
stderr, not stdout. Include a concise `README.md` and run meaningful self-tests.
