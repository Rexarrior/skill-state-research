# CSV Insights

A dependency-free Python 3.11+ command-line tool for exact CSV filtering and
Decimal-based grouped sums and averages.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

`--where` may be repeated; all filters must match. Without `--sum` or `--avg`,
the matching rows are emitted in their original order. Aggregations require
`--group-by`, are sorted by group value, and use exact `Decimal` arithmetic.
Output defaults to JSON; pass `--output csv` for RFC-compliant CSV output.

The input must be UTF-8 CSV with unique, non-empty headers and a consistent
number of fields per record. Errors are written to stderr and return a non-zero
exit status; the input file is never changed.
