# CSV Insights

A dependency-free Python 3.11+ command-line tool for UTF-8 CSV files.

```sh
python3 main.py sales.csv --where region=West --where status=paid
python3 main.py sales.csv --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

Repeat `--where COLUMN=VALUE` to combine exact, case-sensitive string filters
with AND. Values may contain `=`; quote arguments containing spaces. Output
defaults to a JSON array; `--output csv` includes a header. Unaggregated rows
retain input order and values. Quoted commas, quotes, and embedded newlines
are supported. The input is opened read-only.

`--sum` and `--avg` require `--group-by`. Groups sort lexicographically;
`--group-by` alone preserves the filtered rows without aggregation. Aggregate fields are named
`sum_COLUMN` and `avg_COLUMN`. All JSON values, including aggregates, are
strings. Decimal sums are exact; averages use at least 28 significant digits
(round-half-even for repeating results). Numbers use plain minimal decimal
notation. Numeric cells may contain surrounding whitespace or scientific
notation; blanks, non-finite values, and invalid numbers are rejected in
rows that pass the filters.

Empty or duplicate headers, inconsistent record widths (including filtered-out
records), invalid CSV quoting, unknown columns, malformed filters, and invalid
arguments report errors on stderr and exit non-zero. Record numbers count the
header as row 1, regardless of embedded newlines. An empty file is invalid;
a header-only file produces `[]` or a CSV header. A group column whose name
collides with a generated aggregate field is rejected.
