# CSV Insights

CSV Insights is a dependency-free command-line tool for filtering and aggregating
CSV data with Python 3.11 or newer. It uses exact decimal arithmetic for numeric
results and never changes the input file.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Multiple `--where` options are combined with AND and
match cell text exactly. `--sum` and `--avg` require `--group-by`; each option may
be repeated to aggregate multiple columns. Grouped output is sorted by group value.

Examples:

```sh
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The first row must contain unique, non-empty headers, and every data row must have
the same number of fields. Blank or invalid values in aggregated numeric columns
are reported with their row and column. Errors are written to stderr and return a
non-zero exit status.
