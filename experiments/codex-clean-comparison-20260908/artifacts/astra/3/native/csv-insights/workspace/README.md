# CSV Insights

A dependency-free Python 3.11+ command-line tool for UTF-8 CSV files.

```sh
python3 main.py INPUT.csv
python3 main.py INPUT.csv --where region=West --where status=paid
python3 main.py INPUT.csv --group-by region --sum revenue --avg revenue --output csv
```

JSON is the default output; `--output csv` includes a header, even for empty
results. Original cells and decimal aggregates are strings in JSON. Filters
compare exact strings, combine with AND, and split at the first `=` (empty
values are allowed). Rows retain their input order without grouping.

`--sum` and `--avg` require `--group-by`. Groups are sorted lexicographically;
`--group-by` alone returns distinct group values. Aggregate columns are named
`sum_COLUMN` and `avg_COLUMN`. Sums are exact; averages use Decimal with at
least 28 significant digits and half-even rounding for recurring fractions.
Numbers may have surrounding whitespace, signs, decimal points, and exponents.
Output uses plain minimal decimals, never binary floats or scientific notation.

Headers must be nonblank and unique. All rows must match the header width,
including rows excluded by filters. Numeric validation applies to selected
rows and aggregate columns; blanks, NaN, infinity, and invalid numbers fail.
Errors go to stderr with a nonzero exit status. Numeric errors identify the
logical CSV row (header is row 1) and column. Quoted commas and embedded newlines
are supported. The input is opened only for reading and is never modified.

Run the standard-library self-tests:

```sh
python3 -m unittest discover -v
```
