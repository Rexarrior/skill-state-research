# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating
UTF-8 CSV files (an optional UTF-8 BOM is accepted).

```sh
python3 main.py sales.csv
python3 main.py sales.csv --where region=West --where status=paid --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg revenue
python3 main.py --help
```

JSON is the default output; `--output csv` includes a header. All output values,
including aggregate numbers, are strings in JSON. Repeated `--where COLUMN=VALUE`
filters match exact strings and combine with AND. Empty values and values containing
`=` are supported. Ungrouped results retain input order; `--group-by` alone returns
distinct group values, sorted lexicographically.

`--sum` and `--avg` require `--group-by` and produce `sum_COLUMN` and `avg_COLUMN`.
Sums use exact decimal addition. Averages use decimal division with at least 28
significant digits (half-even rounding when necessary). Numbers are rendered without
exponents or redundant fractional zeros. Only matching rows are aggregated and
checked for numeric validity; blank, invalid, and non-finite numeric cells are errors.

Headers must be non-empty and unique. All rows, including filtered-out rows, must
have the correct field count. Quoted commas, quotes, and embedded newlines are
supported. Error messages go to stderr with a nonzero exit status; numeric errors
identify the logical CSV row (header is row 1) and column. Input files are opened
read-only, and results are emitted only after input validation succeeds.

Run the self-tests from the project directory:

```sh
python3 -m unittest discover -v
```
