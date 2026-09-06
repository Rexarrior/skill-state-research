# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV files and
computing grouped sums and averages with exact decimal arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN ...] [--avg COLUMN ...] [--output json|csv]
```

Output defaults to JSON. Without `--sum` or `--avg`, matching rows are emitted
in input order. Filters compare exact text and multiple filters are combined
with AND. Aggregations require `--group-by`; both aggregation options may be
repeated and may be used together.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The input must be UTF-8 RFC-style CSV with a non-empty, unique header and a
consistent number of fields. Invalid or blank cells in aggregated numeric
columns are reported with their row and column. The input file is only read.
