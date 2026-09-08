# CSV Insights

A dependency-free Python 3.11+ command-line tool.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
python3 main.py sales.csv --where region=West --group-by product --sum revenue --avg revenue
python3 main.py sales.csv --where 'product=Tea, green' --output csv
```

JSON is the default. All values, including aggregates, are strings. Filters
compare exact strings, combine with AND, and split on the first `=`. Unaggregated
rows preserve input order. Group values sort lexicographically; `--group-by`
alone returns distinct groups. Sum and average require grouping and may target
different columns. Empty results produce `[]` in JSON or just the CSV header.

Input is UTF-8 CSV with quoted commas and embedded newlines supported. Headers
must be unique and nonblank, and every record must have the expected field count.
The input is only opened for reading. Errors go to stderr with a nonzero exit;
validation completes before output is written.

Aggregations validate numeric cells in matching rows. Decimal and scientific
notation are accepted, with surrounding numeric whitespace ignored; blanks,
NaN, and infinities are rejected. Sums preserve decimal precision. Averages use
Decimal division with at least 28 significant digits and round half to even when
needed (for example, recurring fractions). Output uses plain decimal notation
without unnecessary trailing fractional zeros. Numeric errors identify the CSV
record number (header is record 1) and column; CSV syntax errors report physical
line numbers. Output column name collisions are rejected.

Run the self-tests:

```sh
python3 -m unittest discover -v
```
