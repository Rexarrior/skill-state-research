# CSV Insights

A dependency-free Python 3.11+ CSV analytics CLI.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg revenue --output csv
python3 main.py sales.csv --where region=West --where status=paid --output json
python3 -m unittest discover -v
```

JSON is the default output; values (including aggregates) are strings. CSV output
includes a header even when no rows match. Filters compare exact strings, combine
with AND, and split at the first `=` (empty values are supported).

`--sum` and `--avg` require `--group-by`. Groups are sorted lexicographically;
`--group-by` alone returns distinct group values. Aggregates use Decimal, exact
sums, and plain minimal decimal strings. Repeating averages are rounded using
Decimal's half-even rounding with at least 28 significant digits.

Input is UTF-8 CSV with quoted commas and multiline fields supported. Headers
must be non-empty and unique; every record must have the header's field count.
Numeric cells in matching rows must be valid finite Decimal values. Error row
numbers count logical CSV records, including the header as row 1. Invalid input
or arguments produce a stderr message and nonzero exit. The input is only read.
