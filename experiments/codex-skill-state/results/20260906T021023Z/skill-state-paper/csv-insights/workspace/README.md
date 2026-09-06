# CSV Insights

`main.py` is a dependency-free Python 3.11+ command-line tool for filtering CSV
records and calculating grouped sums and averages with exact decimal arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] \
  [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters are combined with
AND. `--sum` and `--avg` may each be repeated, but any aggregation requires
`--group-by`. Output defaults to JSON; use `--output csv` for CSV.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --group-by region --sum revenue --output csv
```

The input must be UTF-8 CSV with a non-empty, unique header row and a consistent
field count. Blank, invalid, or non-finite values in aggregated numeric columns
are reported as errors. The input file is only read and is never modified.
