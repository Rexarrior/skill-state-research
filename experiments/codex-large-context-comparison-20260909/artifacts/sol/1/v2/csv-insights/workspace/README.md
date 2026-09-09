# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV data and calculating grouped sums and averages with decimal-safe arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Filters are exact string comparisons and repeatable
filters are combined with AND. `--sum` and `--avg` are also repeatable, and each
requires `--group-by`.

Examples:

```sh
python3 main.py sales.csv --where region=North
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --group-by region --sum revenue --output csv
```

The input must have one non-empty, unique name per header field and the same
number of fields in every record. Aggregated cells must contain finite decimal
numbers. Errors are written to stderr and return a non-zero exit status.
