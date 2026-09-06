# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV files and calculating grouped sums and averages.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Examples:

```bash
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where status=paid --output csv
```

Filters compare exact text and repeated filters are combined with AND. Output is
JSON by default. Aggregation requires `--group-by`; grouped output is sorted by
the group value. Input must be UTF-8 RFC-style CSV with a non-empty, unique
header row and a consistent number of fields. Invalid input is reported on
stderr and exits with a non-zero status.
