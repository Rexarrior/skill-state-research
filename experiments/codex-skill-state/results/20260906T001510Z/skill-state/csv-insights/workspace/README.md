# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and grouped
aggregation of RFC-compatible CSV files.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] \
  [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Filters are exact string comparisons and repeated
filters are combined with AND. `--sum` and `--avg` require `--group-by`; both
may be used together. Numeric calculations use `decimal.Decimal`.

Examples:

```sh
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Errors (invalid CSV structure, unknown columns, malformed filters, and invalid
numeric cells) are written to stderr and return a non-zero exit status. The
input file is only opened for reading.

Run the self-tests with:

```sh
python3 -m unittest -v
```
