# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating CSV data. It reads RFC-style CSV (including quoted commas and
embedded newlines), validates the input, and writes JSON or CSV to standard
output without changing the source file.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters are combined with
AND. `--where`, `--sum`, and `--avg` may each be repeated. Sums and averages
require `--group-by` and use decimal arithmetic.

Examples:

```sh
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Errors are printed to standard error and return a non-zero status. Run the
self-tests with:

```sh
python3 -m unittest -v
```
