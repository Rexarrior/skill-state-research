# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV data and calculating grouped sums and averages.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters compare exact strings and repeated `--where` options combine with AND. Without aggregation, matching rows are emitted in input order. `--sum` and `--avg` may be used separately or together, and require `--group-by`.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

JSON is the default output format. Aggregate values are emitted as decimal strings so their exact decimal representation is preserved. Input must be UTF-8 CSV with a non-empty, unique header and a consistent number of fields per record.
