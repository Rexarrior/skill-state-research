# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating
UTF-8 CSV files. It uses Python's RFC-style CSV parser, so quoted commas and
embedded newlines are supported.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Repeated `--where` options are exact-string filters
combined with AND. Aggregation requires `--group-by`; groups are sorted by their
string value and calculations use `decimal.Decimal`.

Examples:

```sh
python3 main.py sales.csv --where 'region=West' --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg units
```

Malformed CSV, invalid headers or row widths, unknown columns, and invalid
numeric cells are reported on stderr with a non-zero exit status. The input
file is opened read-only and is never modified.
