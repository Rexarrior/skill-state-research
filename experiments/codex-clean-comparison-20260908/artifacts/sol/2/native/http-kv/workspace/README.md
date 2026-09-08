# Persistent HTTP key-value service

This repository contains a dependency-free Python 3.11+ HTTP key-value server.
Values are stored as JSON and every mutation is durably written with an atomic
replacement of the data file.

## Run

```sh
python3 server.py --host 127.0.0.1 --port 8080 --data ./data.json
```

Use port `0` to let the operating system choose a free port. The server prints
`LISTENING <port>` to stdout after it is ready. Request diagnostics go to stderr.

## API examples

```sh
curl -i -X PUT http://127.0.0.1:8080/v1/kv/my%20key \
  -H 'Content-Type: application/json' \
  --data '{"value":{"answer":42},"ttl_seconds":60}'
curl http://127.0.0.1:8080/v1/kv/my%20key
curl http://127.0.0.1:8080/v1/keys
curl -i -X DELETE http://127.0.0.1:8080/v1/kv/my%20key
curl http://127.0.0.1:8080/health
```

Keys are URL-encoded UTF-8 path segments. They may contain spaces, but must be
non-empty and cannot contain `/`. Bodies are limited to 1 MiB. A positive,
finite `ttl_seconds` makes an entry expire; expired entries behave as missing.

## Test

```sh
python3 -m unittest -v
```
