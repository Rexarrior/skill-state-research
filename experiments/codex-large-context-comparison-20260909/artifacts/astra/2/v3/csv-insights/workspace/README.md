# CSV Insights

A dependency-free Python 3.11+ command-line tool for UTF-8 CSV files.

```sh
python3 main.py INPUT.csv
python3 main.py INPUT.csv --where region=West --where status=paid
python3 main.py INPUT.csv --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

JSON is the default output; `--output csv` includes a header, even for empty
results. Values in JSON are strings, including aggregate decimals, so precision
is preserved. Quoted commas and embedded newlines are supported.

Filters match exact strings, combine with AND, and split on the first `=`;
`--where column=` matches an empty cell. Unaggregated rows retain input order.
`--sum` and `--avg` require `--group-by`. Groups sort lexicographically;
`--group-by` alone returns distinct group values. Aggregate columns are named
`sum_COLUMN` and `avg_COLUMN`.

Sums retain full decimal precision. Averages use Decimal division with at least
28 significant digits (round-half-even); repeating fractions are rounded.
Decimals use plain notation without unnecessary trailing fractional zeros.
Only matching rows undergo numeric validation; all rows undergo field-count
validation. Blank, invalid, and non-finite aggregate values are errors.

Headers must be non-empty and unique; whitespace in names and string values is
preserved. Errors go to stderr with a non-zero exit status. Numeric diagnostics
use logical CSV row numbers, counting the header as row 1; CSV syntax errors
report physical lines. Input is opened read-only, and validation completes
before output is emitted.
