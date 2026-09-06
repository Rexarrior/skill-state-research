# CSV Insights

A dependency-free Python 3.11+ CLI for filtering CSV rows and calculating grouped sums and averages.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters combine with AND. Aggregation options require `--group-by`; `--sum` and `--avg` may each be repeated. Output defaults to JSON.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```
