# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating CSV data.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters combine with AND. JSON is the default output; use `--output csv` for CSV. Aggregations require `--group-by`, sort groups lexicographically, and use exact decimal arithmetic.

Examples:

```console
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Input must be UTF-8 CSV with a non-empty, unique header. Invalid row widths and invalid or blank aggregated numeric cells are reported as errors. To run the included tests:

```console
python3 -m unittest -v
```
