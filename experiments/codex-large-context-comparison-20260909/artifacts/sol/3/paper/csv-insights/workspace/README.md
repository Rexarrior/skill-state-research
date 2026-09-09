# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating RFC-style CSV files.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Repeated `--where` options use exact string matching
and combine with AND. Aggregation requires `--group-by`; `--sum` and `--avg`
may be used separately or together. Aggregate values are emitted as exact,
minimal decimal strings.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Run the self-tests with:

```sh
python3 -m unittest -v
```
