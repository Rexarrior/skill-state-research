# CSV Insights

Dependency-free Python 3.11+ command-line CSV filter and aggregation tool.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Examples:

```sh
python3 main.py sales.csv --where region=EU
python3 main.py sales.csv --group-by region --sum revenue --avg revenue --output csv
```

Input must have unique, non-empty headers and consistently sized rows. Filters are
exact string matches and are combined with AND. Aggregates use decimal arithmetic.
