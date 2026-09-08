# CSV Insights

A dependency-free Python 3.11+ command-line tool. Run:

```sh
python3 main.py INPUT.csv --where region=West
python3 main.py INPUT.csv --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

Repeat `--where COLUMN=VALUE` to combine exact, case-sensitive filters with AND.
Values may be empty or contain `=`. Quote arguments containing shell special
characters. Unknown columns and invalid input produce stderr errors and a nonzero
exit status. The input is opened read-only as UTF-8 (an optional BOM is accepted).

Output defaults to a JSON array; `--output csv` includes a header, even for an
empty result. All JSON values are strings. Without `--sum` or `--avg`, filtered
rows retain their original order and columns, including when `--group-by` is given.
Aggregates require `--group-by`, sort groups lexicographically, and produce the
group column followed by `sum_COLUMN` and/or `avg_COLUMN`. Conflicting output
column names are rejected.

Sums use exact decimal arithmetic. Averages use decimal arithmetic with at least
28 significant digits and round-half-even rounding for repeating results.
Numbers use plain notation without redundant fractional zeros. Numeric cells in
matching rows must be nonblank, valid, finite decimals; filtered-out rows are not
numerically evaluated. Every record is checked for the correct field count.
Errors identify logical CSV record numbers (the header is row 1); CSV syntax
errors identify physical lines. Quoted commas, quotes, and newlines are supported.
