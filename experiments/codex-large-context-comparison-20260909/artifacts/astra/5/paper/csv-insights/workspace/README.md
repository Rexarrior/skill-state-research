# CSV Insights

A dependency-free Python 3.11+ command-line tool for CSV filtering and grouped analytics.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
python3 main.py sales.csv --where region=West --group-by product --sum revenue --avg revenue
python3 main.py sales.csv --where 'product=Tea, green' --output csv
```

JSON is the default. Values (including aggregate results) are strings. CSV output includes a header, even when no rows match. Input is UTF-8 and is never modified; quoted commas and multiline fields are supported.

Filters compare exact strings, combine with AND, and split at the first `=` (an empty value is allowed). Without `--sum` or `--avg`, matching rows retain input order; `--group-by` alone does not aggregate. Both aggregates require `--group-by`. Groups sort lexicographically and produce `sum_COLUMN` and/or `avg_COLUMN` fields.

Arithmetic uses Decimal, with exact sums and plain decimal output without trailing fractional zeros. Recurring averages are rounded using half-even rounding to at least 28 significant digits. Only matching rows undergo numeric validation; blank, invalid, and non-finite values are rejected. Error row numbers count CSV records, with the header as row 1.

Empty or duplicate headers, inconsistent field counts (including filtered-out rows), malformed CSV, unknown columns, and invalid arguments produce a nonzero exit and a stderr message. Aggregate output names must be unique.

Run self-tests with `python3 -m unittest discover -v`.
