# CSV Insights

A dependency-free Python 3.11+ CLI for UTF-8 CSV files.

```sh
python3 main.py INPUT.csv
python3 main.py INPUT.csv --where region=West --where status=paid
python3 main.py INPUT.csv --group-by region --sum amount --avg amount --output csv
```

Output defaults to JSON. Repeated filters compare exact strings and combine
with AND; filter values may contain `=`. Filtered rows retain input order.
`--sum` and `--avg` require `--group-by`. Groups sort lexicographically;
without an aggregate, `--group-by` preserves the filtered rows. Aggregate columns are named
`sum_COLUMN` and `avg_COLUMN`. All JSON cell values, including aggregates,
are strings. Empty results produce `[]` or a CSV header.

Sums use exact Decimal arithmetic. Averages use at least 28 significant digits
(with additional precision for large totals); repeating decimals are rounded
using Decimal's round-half-even rule. Decimal output uses plain notation
without unnecessary trailing zeros.

CSV supports quoted commas, quotes, and embedded newlines. Headers must be
non-empty and unique; every record must have the correct field count.
Numeric cells in matching rows must be finite decimals. Errors go to stderr
with a nonzero exit status; numeric errors identify the logical CSV record
(header is row 1) and column. Input files are opened read-only.

Run self-tests with `python3 -m unittest discover -v`.
