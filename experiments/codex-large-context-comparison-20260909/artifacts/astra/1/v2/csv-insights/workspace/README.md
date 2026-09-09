# CSV Insights

A dependency-free Python 3.11+ CLI for filtering UTF-8 CSV and grouped analytics.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --where status=paid --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

Repeat `--where COLUMN=VALUE` to combine exact, case-sensitive comparisons with
AND. Values may be empty or contain `=`; shell-quote arguments containing spaces.
JSON is the default output. Input fields and numeric results are JSON strings,
so precision survives serialization. CSV output always includes a header.

`--sum` and `--avg` require `--group-by`. Groups sort lexicographically;
`--group-by` alone returns distinct group values. Otherwise rows retain input
order. Filters run before aggregation; only matching rows need valid numeric
cells, but all rows must have the correct field count. Numeric cells allow
surrounding whitespace, signs, decimal points, and scientific notation; blanks,
NaN, and infinity are errors. Sums are exact. Averages use Decimal division with
at least 28 significant digits and round-half-even. Results use plain decimal
notation without redundant fractional zeroes.

Quoted commas, escaped quotes, and embedded newlines are supported. Headers must
be non-empty and unique. Empty files, malformed CSV, unknown columns, invalid
arguments, and conflicting output column names fail with a stderr diagnostic
and nonzero exit status. Row numbers count logical CSV records, including the
header as row 1. CSV syntax diagnostics report physical lines. The input is
opened read-only, and input validation completes before output is emitted.
