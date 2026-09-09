# CSV Insights

A dependency-free Python 3.11+ tool for filtering and grouping CSV files.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

Input is UTF-8 (an optional BOM is accepted), with a header and comma-separated
records. Quoted commas, quotes, and embedded newlines are supported. Headers must
be non-empty and unique; every record must have exactly the header's field count.
The input file is only read.

Repeat `--where COLUMN=VALUE` to combine exact, case-sensitive string comparisons
with AND. Values can be empty or contain `=`. Matching rows retain input order.
JSON is the default output; `--output csv` includes a header even with no results.
All output values, including aggregates, are strings.

`--sum COLUMN` and `--avg COLUMN` require `--group-by COLUMN`. Groups are sorted
lexicographically and output uses `sum_COLUMN` and `avg_COLUMN` names. Without `--sum` or `--avg`, grouping alone preserves the filtered rows
in input order. Generated names cannot collide with the group
column. Empty results produce `[]` in JSON.

Numeric cells in matching rows must be finite Decimal values; blanks and invalid
values report the column and logical record number (header is record 1).
Sums preserve decimal precision. Averages use at least 28 significant digits
(round-half-even), increasing precision for large totals; repeating fractions
are rounded. Decimal strings use plain notation without redundant trailing zeros.
Structural CSV errors are checked even in excluded rows. Errors are written to
stderr with a nonzero exit status; input validation finishes before output begins.
