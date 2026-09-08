# CSV Insights

CSV Insights is a dependency-free command-line tool for filtering CSV data and calculating grouped sums and averages. It requires Python 3.11 or newer.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated `--where` options are combined with AND. JSON is the default output format. Aggregation requires `--group-by`; results are sorted by the group value and decimal results are emitted as exact, minimal strings.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The tool validates headers, row widths, requested columns, filters, and numeric input. Errors are written to stderr and return a non-zero exit status. The input file is opened read-only and is never modified.

Run the self-tests with:

```sh
python3 -m unittest -v
```
