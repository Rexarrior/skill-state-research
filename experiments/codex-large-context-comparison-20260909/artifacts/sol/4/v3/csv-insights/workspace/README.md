# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering and aggregating CSV data. It reads RFC-style CSV (including quoted commas and embedded newlines), validates its structure, and never changes the input file.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Filters are exact string comparisons and repeated filters are combined with AND. Aggregations require `--group-by`; results are sorted by group value. Output defaults to JSON, while `--output csv` writes an RFC-compliant CSV document to standard output. Aggregate values are emitted as precision-preserving minimal decimal strings.

Errors, including invalid CSV shape, unknown columns, malformed filters, and invalid numeric values, are written to standard error and return a non-zero exit status.
