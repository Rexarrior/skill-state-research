# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV records and calculating grouped sums and averages. It parses quoted commas
and embedded newlines with Python's RFC-compatible `csv` module and uses
`decimal.Decimal` for numeric calculations.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Filters compare exact text and repeated filters are
combined with AND. Aggregation requires `--group-by`; `--sum` and `--avg` may
both be used (and may each be repeated for additional columns).

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where status=paid --output csv
```

Malformed CSV, invalid numeric cells, unknown columns, and invalid arguments
produce a descriptive error on standard error and a non-zero exit status. The
input file is opened read-only and is never modified.
