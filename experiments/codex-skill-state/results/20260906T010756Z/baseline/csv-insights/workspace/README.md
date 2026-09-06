# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV records and
calculating grouped sums and averages with exact decimal input handling.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                          [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are repeatable and combine with AND. `--sum` and `--avg` require
`--group-by`; both can be used together. Output defaults to JSON, while
`--output csv` writes an RFC-compatible header and rows. Aggregate values are
emitted as plain decimal strings so their representation stays exact.

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where status=paid --output csv
```

Run the self-tests with:

```sh
python3 -m unittest -v
```
