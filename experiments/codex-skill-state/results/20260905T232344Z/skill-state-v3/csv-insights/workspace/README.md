# CSV Insights

`main.py` is a dependency-free Python 3.11+ command-line tool for filtering CSV data and calculating grouped sums and averages.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Examples:

```sh
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Filters use exact string equality and multiple filters are combined with AND. JSON is the default output format. Aggregations require `--group-by`; their values are parsed and calculated with `decimal.Decimal`. Invalid headers, uneven rows, malformed CSV, unknown columns, and invalid numeric cells are reported on stderr with a non-zero exit status.

The input file is opened read-only and is never modified.
