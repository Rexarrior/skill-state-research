# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating
CSV data. It uses Python's RFC-aware CSV parser and `decimal.Decimal` for exact
numeric calculations.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters are combined with
AND. `--sum` and `--avg` require `--group-by`; each may be repeated to calculate
multiple columns. Output defaults to JSON. Aggregate values are JSON numbers,
rendered directly from decimals without conversion through floating point.

Examples:

```sh
python3 main.py sales.csv --where region=West --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg units
```

Malformed CSV, invalid headers or row widths, unknown columns, and invalid
numeric values produce a useful error on stderr and a non-zero exit status.
