# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating
RFC-style CSV files.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters use exact string comparison and combine with AND. Without aggregation,
matching rows retain input order. `--sum` and `--avg` may be repeated and require
`--group-by`; aggregation uses exact decimal arithmetic and groups are sorted by
their string value. Output defaults to JSON.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Malformed CSV, invalid headers or row widths, unknown columns, malformed filters,
and invalid numeric cells produce a useful error on stderr and a non-zero exit.

Run the self-tests with:

```sh
python3 -m unittest -v
```
