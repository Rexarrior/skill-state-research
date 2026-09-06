# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV data and
calculating grouped sums and averages with exact decimal arithmetic.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

`--where` is repeatable and all filters must match exactly. Without aggregation,
matching rows are emitted in input order. `--sum` and `--avg` require
`--group-by`; grouped output is sorted by the group value. Output defaults to
JSON. Use `--output csv` for RFC-compliant CSV.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Malformed CSV, invalid numeric cells, unknown columns, and invalid arguments are
reported on stderr and produce a non-zero exit status.
