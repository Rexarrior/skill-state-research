# CSV Insights

Dependency-free CSV analytics for Python 3.11+.

```sh
python3 main.py sales.csv --where region=East --where status=paid
python3 main.py sales.csv --group-by region --sum revenue --avg revenue
python3 main.py sales.csv --where status=paid --output csv
python3 -m unittest discover -v
```

Filters match exact strings and combine with AND; values may contain `=`.
Without grouping, rows retain input order. Grouping emits lexicographically
sorted group values; `--group-by` alone emits distinct values. Sum and average
require grouping and may refer to different columns. Output defaults to JSON;
all values, including aggregates, are strings. CSV output always has a header,
even when no rows match.

Sums use exact decimal arithmetic. Averages are exact when terminating and
otherwise rounded with half-even rounding to at least 28 significant digits
(more for large coefficients). Decimal strings use no exponent or unnecessary
trailing fractional zeros.

Input is UTF-8 CSV with quoting, quoted commas, and embedded newlines supported.
Headers must be non-empty and unique; every record must have the correct field
count, even if filtered out. Numeric cells in matching records must be finite,
non-blank decimals. Numeric errors report the logical record number (header is
record 1) and column; CSV syntax errors report a physical line number.
Errors go to stderr with non-zero exit status. The input is opened read-only.
