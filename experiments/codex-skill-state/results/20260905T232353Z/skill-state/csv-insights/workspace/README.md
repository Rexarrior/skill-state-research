# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV data and
calculating grouped sums and averages with exact decimal arithmetic.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                          [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and multiple `--where` options are joined
with AND. Without aggregation, matching rows remain in input order. `--sum`
and `--avg` require `--group-by` and may be used together. Groups are sorted by
their group value. Output defaults to JSON; use `--output csv` for CSV.

Examples:

```sh
python3 main.py sales.csv --where 'country=DE' --output csv
python3 main.py sales.csv --group-by category --sum revenue --avg units
```

The input must be UTF-8 RFC-style CSV with a non-empty, unique header. Invalid
rows, columns, filters, and numeric values produce a descriptive error and a
non-zero exit status. The input file is only read and is never modified.
