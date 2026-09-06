# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating
CSV data. It uses exact string matching for filters and `decimal.Decimal` for
numeric calculations.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Filters can be repeated and are combined with AND.
`--sum` and `--avg` can each be repeated, and require `--group-by`.

Examples:

```console
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where active=yes --output csv
```

Malformed CSV, invalid headers or row widths, unknown columns, and invalid
numeric cells produce a diagnostic on stderr and a non-zero exit status. The
input file is opened read-only and is never modified.
