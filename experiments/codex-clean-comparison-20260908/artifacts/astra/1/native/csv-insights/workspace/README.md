# CSV Insights

A dependency-free Python 3.11+ command-line tool for UTF-8 CSV files.

```sh
python3 main.py sales.csv
python3 main.py sales.csv --where region=West --where status=paid --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg revenue
python3 -m unittest discover -v
```

Output defaults to JSON (an array of objects); `--output csv` includes a header.
All values, including aggregates, are strings in JSON. Filters compare exact
strings and combine with AND. Split filters at the first `=`; empty values are
allowed. Quote arguments containing spaces in your shell.

Unaggregated rows preserve input order. `--group-by` emits sorted groups;
without metrics it emits distinct group values. `--sum` and `--avg` each accept
one column and require `--group-by`. Results use `sum_COLUMN` and `avg_COLUMN`.
Sums use exact Decimal arithmetic. Averages use at least 28 significant digits
(more for large totals), with round-half-even rounding for repeating decimals.
Numbers are emitted in plain minimal decimal notation. Numeric cells may have
surrounding whitespace and decimal exponents; blank, non-finite, and invalid
values in selected rows are errors.

CSV supports quoted commas, escaped quotes, and embedded newlines. Headers must
be non-empty and unique. Every record is checked for field count, even if a
filter excludes it. Diagnostics identify logical row numbers (header is row 1);
CSV syntax errors report physical lines. Invalid input and arguments produce
stderr diagnostics and a nonzero exit status. Input is opened read-only, and
validation finishes before results are emitted. A UTF-8 BOM is accepted.
