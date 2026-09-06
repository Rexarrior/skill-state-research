# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating CSV files.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN ...] [--avg COLUMN ...] [--output json|csv]
```

Filters compare exact strings and combine with AND. Aggregations require `--group-by`; `--sum` and `--avg` can each be repeated. Output defaults to JSON.

Examples:

```sh
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Run the self-tests with:

```sh
python3 -m unittest -v
```
