# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating RFC-4180-style CSV files.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output format. Filters are exact string comparisons and
multiple filters are combined with AND. `--sum` and `--avg` may be repeated,
but require `--group-by`. Aggregate values are emitted as plain decimal strings
to preserve exact decimal representation.

Examples:

```sh
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where active=yes --output csv
```

The tool validates headers, row widths, requested columns, filters, and numeric
cells. Errors are written to stderr and return a non-zero exit status. The input
file is opened read-only and is never modified.
