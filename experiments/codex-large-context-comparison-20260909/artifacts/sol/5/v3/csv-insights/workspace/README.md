# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating CSV data.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons, and repeated `--where` options combine with AND. Without aggregation, matching rows are emitted in input order. `--sum` and `--avg` require `--group-by`; grouped output is sorted by the group value. JSON is the default output format.

Examples:

```console
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The input must be UTF-8 CSV with a non-empty, unique header and a consistent number of fields. Numeric aggregation uses decimal arithmetic and reports blank or invalid cells as errors.
