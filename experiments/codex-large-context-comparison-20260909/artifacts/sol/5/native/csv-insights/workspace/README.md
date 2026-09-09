# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV records and calculating exact grouped sums and averages.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters compare exact strings and repeated `--where` options are combined with
AND. The default output is JSON; use `--output csv` for RFC-compliant CSV.
`--sum` and `--avg` require `--group-by`, and numeric input is processed with
`decimal.Decimal` rather than binary floating point.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Run the self-tests with:

```sh
python3 -m unittest -v
```
