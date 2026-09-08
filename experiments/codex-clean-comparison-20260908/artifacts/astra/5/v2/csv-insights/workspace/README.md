# CSV Insights

A dependency-free Python 3.11+ command-line tool:

```sh
python3 main.py INPUT.csv --where region=West
python3 main.py INPUT.csv --group-by region --sum sales --avg sales --output csv
python3 -m unittest discover -s tests -v
```

Repeat `--where COLUMN=VALUE` to combine exact, case-sensitive filters with AND.
Values may contain `=` or be empty. Quote arguments containing shell whitespace.
JSON is the default; CSV output always includes headers, even for no matches.
Input values and aggregate decimals are strings in JSON. Rows preserve input
order; groups sort lexicographically. `--group-by` alone lists distinct groups.
Both `--sum` and `--avg` require `--group-by`.

UTF-8 input (with an optional BOM) supports quoted commas and embedded newlines.
Headers must be unique and nonblank, and every record must have the correct
field count. Errors go to stderr with a nonzero exit status. Numeric errors
identify the column and logical record number (the header is record 1).
Only matching records undergo numeric validation; blank and nonfinite numeric
values are rejected. Input files are opened read-only.

Sums use sufficient Decimal precision for exact addition. Averages use at least
28 significant digits (more for large sum coefficients), with Decimal's
half-even rounding for repeating results. Output uses plain decimal notation
without unnecessary trailing zeros. Aggregate names are `sum_COLUMN` and
`avg_COLUMN`; queries producing duplicate output names are rejected.
