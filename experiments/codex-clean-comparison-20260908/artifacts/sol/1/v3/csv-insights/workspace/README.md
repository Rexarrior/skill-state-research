# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating CSV data. It uses Python's CSV parser for quoted commas and
embedded newlines, and `decimal.Decimal` for exact decimal arithmetic.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Repeated `--where` options are exact-string filters
combined with AND. Aggregation requires `--group-by`; groups are sorted by the
group value.

Examples:

```console
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where status=paid --group-by team --sum amount --output csv
```

Malformed CSV, invalid headers or row lengths, unknown columns, and invalid
numeric cells produce a useful error on standard error and a non-zero exit
status. The input file is opened read-only and is never modified.
