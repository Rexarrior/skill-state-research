# CSV Insights

Dependency-free Python 3.11+ CLI for filtering and aggregating CSV data.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum amount --avg amount --output csv
```

Filters use exact string matches and combine with AND. Aggregations use exact decimal arithmetic; `--sum` and `--avg` require `--group-by`. JSON is the default output format.
