# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating CSV data.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters use exact string comparison and repeated `--where` options combine with AND. `--sum` and `--avg` may each be repeated, but require `--group-by`:

```sh
python3 main.py sales.csv --where region=West --group-by product \
  --sum revenue --avg units --output csv
```

JSON is the default output. CSV input must be UTF-8 with a non-empty, unique header row and a consistent field count. Numeric aggregation uses decimal arithmetic; blank, invalid, and non-finite numeric values are rejected with their logical row and column.

Run the self-tests with:

```sh
python3 -m unittest -v
```
