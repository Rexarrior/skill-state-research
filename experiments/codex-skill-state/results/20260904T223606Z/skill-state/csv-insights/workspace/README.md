# CSV Insights

Dependency-free Python 3.11+ CLI for filtering and grouping CSV data.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

The default output is JSON. Use `--output csv` for RFC-compliant CSV output.
Filters use exact string equality and combine with AND. `--sum` and `--avg`
require `--group-by`; grouped records are ordered by their group value. Numeric
aggregation uses `decimal.Decimal`, so results avoid floating-point artifacts.

Example:

```sh
python3 main.py sales.csv --where region=EU --group-by product --sum revenue --avg revenue
```

Input must be UTF-8 CSV with non-empty, unique headers and the same number of
fields in every data row. Errors are printed to stderr and return a non-zero
status; the source file is only read.
