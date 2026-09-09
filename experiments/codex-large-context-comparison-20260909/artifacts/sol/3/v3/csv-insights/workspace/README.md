# CSV Insights

CSV Insights is a dependency-free command-line tool for filtering and aggregating CSV files with Python 3.11 or newer. It reads RFC-style CSV (including quoted commas and embedded newlines), validates its input, and uses exact decimal arithmetic for sums and averages.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Filters are exact string comparisons and repeated filters are combined with AND. `--where`, `--sum`, and `--avg` may each be repeated. Aggregations require `--group-by`.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Errors such as duplicate or empty headers, uneven rows, unknown columns, malformed filters, and invalid numeric cells are reported on stderr with a non-zero exit status. The input file is opened read-only and is never modified.
