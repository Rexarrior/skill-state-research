# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating CSV files.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated `--where` options combine with AND. Without aggregation, matching rows are emitted in input order. `--sum` and `--avg` are repeatable, use exact decimal arithmetic, and require `--group-by`; grouped output is sorted by the group value. Output defaults to JSON.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The input must be UTF-8 RFC-style CSV with a non-empty, unique header and a consistent field count. Invalid numeric cells, malformed CSV, malformed filters, and unknown columns produce a non-zero exit status and an explanatory error on stderr. The input file is only read and is never modified.
