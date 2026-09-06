# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV data and calculating grouped sums and averages with exact decimal input.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters compare strings exactly and combine with AND. With no aggregation, the
matching rows are emitted in their original order. `--sum` and `--avg` require
`--group-by`; they may be used separately or together. Output defaults to JSON.

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

CSV input must be UTF-8 and have unique, non-empty headers. Invalid row widths,
unknown columns, malformed filters, and blank or invalid aggregated numbers are
reported on stderr with a non-zero exit status. The input file is only read.

Run the self-tests with:

```sh
python3 -m unittest -v
```
