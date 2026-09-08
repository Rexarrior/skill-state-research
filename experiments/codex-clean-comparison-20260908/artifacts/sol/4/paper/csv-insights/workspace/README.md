# CSV Insights

A dependency-free command-line tool for filtering and aggregating CSV files with Python 3.11 or newer.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

`--where` may be repeated; filters use exact string equality and combine with AND. Without aggregation, matching rows retain input order. `--sum` and `--avg` require `--group-by`, and may be used separately or together. Groups are sorted by their string value. Output defaults to JSON; use `--output csv` for CSV.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The parser supports quoted commas and embedded newlines. Invalid headers, uneven rows, unknown columns, malformed filters, and invalid numeric values produce a non-zero exit status with an explanatory message. Aggregations use exact decimal arithmetic.
