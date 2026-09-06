# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating
CSV data. It parses quoted fields and embedded newlines with Python's standard
RFC-style CSV support and uses `Decimal` for exact numeric calculations.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters may be repeated and are combined with AND. Without aggregation, matching
rows are emitted in input order. `--sum` and `--avg` require `--group-by`; they
can be used separately or together. Output defaults to JSON.

Examples:

```console
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Malformed CSV, invalid headers or row widths, unknown columns, invalid numeric
cells, and invalid command-line combinations produce a useful error on stderr
and a non-zero exit status. Input files are opened read-only and never modified.
