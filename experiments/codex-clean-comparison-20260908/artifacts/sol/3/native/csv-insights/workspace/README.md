# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating CSV data.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Repeated `--where` options are combined with AND. Aggregation
requires `--group-by`; groups are sorted by their exact string value and calculations use
decimal arithmetic.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Run the self-tests with:

```sh
python3 -m unittest -v
```
