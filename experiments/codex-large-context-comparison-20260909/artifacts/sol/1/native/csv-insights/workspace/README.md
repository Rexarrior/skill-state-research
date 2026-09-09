# CSV Insights

CSV Insights is a dependency-free command-line tool for filtering and aggregating
CSV files with Python 3.11 or newer.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] \
  [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Rows are emitted as JSON by default. Use `--output csv` for CSV output. Repeated
`--where` options are exact-string filters combined with AND. To aggregate, specify
`--group-by` and at least one of `--sum` or `--avg`:

```sh
python3 main.py sales.csv --where status=paid --group-by region \
  --sum amount --avg amount --output csv
```

The tool validates headers and row widths, reports malformed CSV and invalid
numeric cells on standard error, and performs arithmetic with `decimal.Decimal`.
It only reads the input file.
