# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating
CSV data. It handles RFC-style quoting, including commas and newlines inside
quoted fields, and performs numeric calculations with `decimal.Decimal`.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] \
  [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Repeated `--where` filters use exact string matching
and combine with AND. `--sum` and `--avg` may be used together or separately,
but require `--group-by`.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Malformed CSV, invalid numbers, unknown columns, and invalid arguments produce
a useful error on stderr and a non-zero exit status. The input file is only
opened for reading.
