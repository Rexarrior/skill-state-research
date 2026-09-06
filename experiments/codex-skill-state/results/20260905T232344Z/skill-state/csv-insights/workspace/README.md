# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV data and
calculating grouped sums and averages.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters use exact string matching and combine with AND. Without aggregation,
matching rows are emitted in input order. `--sum` and `--avg` require
`--group-by`; grouped output is sorted by the group value. JSON is the default
output format.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The input must be UTF-8 CSV with a non-empty, unique header and a consistent
number of fields. Numeric aggregation uses decimal arithmetic; blank, invalid,
or non-finite numeric values are rejected with their row and column.
