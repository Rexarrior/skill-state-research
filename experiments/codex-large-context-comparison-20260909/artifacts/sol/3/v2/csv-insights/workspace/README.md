# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV records and calculating grouped sums and averages. It uses Python's CSV
parser for quoted commas and embedded newlines, and `decimal.Decimal` for
numeric calculations.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Filters are exact string comparisons and repeated
filters are combined with AND. `--where`, `--sum`, and `--avg` may each be
repeated. Aggregation requires `--group-by`; groups are sorted by their exact
string value.

Examples:

```console
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where status=paid --output csv
```

Malformed CSV, invalid headers or row widths, unknown columns, and invalid
numeric cells are reported on standard error and produce a non-zero exit code.
The input file is opened read-only and is never modified.
