# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
RFC-style CSV files and calculating grouped sums and averages with exact decimal
arithmetic. The input file is only read and is never modified.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] \
  [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Filters are exact string comparisons and repeated
filters combine with AND. `--sum` and `--avg` are repeatable; aggregation options
require `--group-by`.

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Malformed CSV, invalid rows or numbers, unknown columns, and invalid arguments
produce a useful error on stderr and a non-zero exit status.
