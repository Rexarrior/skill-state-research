# CSV Insights

A dependency-free Python 3.11+ command-line tool for UTF-8 CSV files.

```sh
python3 main.py sales.csv
python3 main.py sales.csv --where region=West --where status=paid
python3 main.py sales.csv --group-by region --sum revenue --avg revenue --output csv
```

`--output json|csv` defaults to JSON. Repeat `--where COLUMN=VALUE` for exact,
case-sensitive AND filters; values may be empty or contain `=`. Quote shell
arguments containing spaces. Rows retain their input order unless aggregated.
`--sum` and `--avg` require `--group-by`; grouping alone returns filtered rows.
Groups sort lexicographically, with columns `sum_COLUMN` and `avg_COLUMN`.

All output values are strings. Decimal sums and terminating averages are exact;
recurring averages use 28 significant digits with round-half-even rounding.
Numbers use plain decimal notation without redundant fractional zeros.
Numeric validation applies to rows selected by the filters; blank and non-finite
numbers are rejected. Error row numbers count CSV records, including the header
as row 1, so embedded newlines do not increment the record number.

Headers must be non-empty and unique. Every row must match the header width.
Quoted commas, quotes, and embedded newlines are supported. Invalid input or
arguments produce a nonzero exit status and an error on stderr. The input file
is opened read-only; validation finishes before output starts.

Run the integration self-tests with:

```sh
python3 -m unittest -v
```
