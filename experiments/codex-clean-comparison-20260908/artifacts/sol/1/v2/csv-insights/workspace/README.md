# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV records and
calculating grouped sums and averages with exact decimal arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Filters compare exact strings and combine with AND.
`--sum` and `--avg` may be used separately or together, and require
`--group-by`. Aggregated results are sorted by group value.

Examples:

```sh
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The input must be UTF-8 RFC-style CSV with a unique, non-empty name for every
column and the same number of fields in every record. Numeric aggregation rejects
blank, invalid, NaN, and infinite values. Errors are written to stderr and return
a non-zero status. The input file is only read and is never modified.

Run the self-tests with:

```sh
python3 -m unittest -v
```
