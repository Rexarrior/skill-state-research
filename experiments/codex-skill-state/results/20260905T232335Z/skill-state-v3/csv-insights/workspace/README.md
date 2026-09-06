# CSV Insights

CSV Insights is a dependency-free command-line tool for filtering and aggregating
CSV files with exact decimal arithmetic. It requires Python 3.11 or newer.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                          [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters compare exact strings and repeated `--where` options combine with AND.
`--sum` and `--avg` may each be repeated, but require `--group-by`. Output defaults
to JSON; use `--output csv` for CSV.

Examples:

```sh
python3 main.py sales.csv --where 'region=North' --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg units
```

The input must be UTF-8 CSV with a non-empty, unique header row and a consistent
number of fields. Numeric aggregation rejects blank, invalid, and non-finite
values. The input file is only opened for reading.
