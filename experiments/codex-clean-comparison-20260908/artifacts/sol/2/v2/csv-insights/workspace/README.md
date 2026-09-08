# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV data and calculating exact grouped sums and averages.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons, and repeated `--where` options combine
with AND. Aggregation requires `--group-by` and at least one of `--sum` or
`--avg`. Output defaults to JSON; select RFC-compliant CSV with `--output csv`.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The input must have unique, non-empty headers and consistently sized rows.
Aggregate cells must contain finite decimal numbers. Errors are written to
standard error and produce a non-zero exit status; the input file is only read.
