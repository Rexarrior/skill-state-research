# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV data and calculating grouped sums and averages with exact decimal arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are repeatable, combine with AND, and compare field values exactly. JSON
is the default output; use `--output csv` for RFC-compatible CSV. Aggregates
require `--group-by`, and numeric cells used by an aggregate must be valid,
non-blank finite decimals.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Run the self-tests with:

```sh
python3 -m unittest -v
```
