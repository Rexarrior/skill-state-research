# CSV Insights

A dependency-free Python 3.11+ command-line CSV analytics tool.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
python3 main.py sales.csv --where region=West --where status=paid
python3 main.py sales.csv --group-by region --sum revenue --avg revenue --output csv
```

Input is UTF-8 CSV (an optional UTF-8 BOM is accepted), including quoted commas,
quotes, and embedded newlines. Headers must be non-empty and unique; every data
record must have the same number of fields as the header. The input is only read.

Filters match exact strings and combine with AND. Split filters at the first `=`;
`--where column=` matches an empty cell. Quote shell arguments containing spaces.
Filtered rows retain input order and their original string values. JSON is the
default output and is always an array of objects; CSV includes a header even when
there are no results.

`--sum` and `--avg` require `--group-by`. Grouping returns one row per distinct
matching group, sorted lexicographically; grouping alone lists distinct values.
Aggregate columns are named `sum_COLUMN` and `avg_COLUMN`. Numeric cells in
matching rows must be finite Decimal values; whitespace and scientific notation
are accepted. Blank or invalid values report the logical CSV row (header is row
1) and column. All rows, including those excluded by filters, are checked for
correct field counts.

Sums retain all decimal digits. Averages use 28 significant digits with
round-half-even. Aggregates are plain decimal **strings**, including in JSON,
with no exponent, unnecessary trailing fractional zeros, or negative zero.
Invalid arguments, unknown columns, ambiguous output column names, and malformed
input produce a nonzero exit status and a diagnostic on stderr.

Run the self-tests with:

```sh
python3 -m unittest discover -v
```
