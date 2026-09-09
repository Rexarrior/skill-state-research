# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating
CSV files. It uses the standard library CSV parser, validates headers and row
widths, and performs exact decimal arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and multiple filters combine with AND.
The default output is JSON. Without aggregation, matching records retain input
order. `--sum` and `--avg` require `--group-by`; each may be repeated, and
grouped output is sorted by group value.

Examples:

```sh
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Errors (including malformed CSV, unknown columns, invalid numeric values, and
invalid arguments) are written to stderr and return a non-zero exit status.
