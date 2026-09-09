# CSV Insights

A dependency-free Python 3.11+ CLI for UTF-8 CSV files (an optional BOM is accepted).

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --where status=paid --group-by region --sum revenue --avg revenue
python3 main.py sales.csv --group-by region --sum revenue --output csv
python3 -m unittest discover -s tests -v
```

JSON is the default output; all values, including aggregates, are strings. CSV
output includes headers, even when no rows match. Filters use exact string
equality and combine with AND. Split filters at the first `=`; empty values and
values containing `=` are supported. Quote shell arguments containing spaces.

Without grouping, matching rows retain input order. Groups are sorted by their
string values. `--group-by` alone returns distinct group values. `--sum` and
`--avg` each accept one column and require `--group-by`; both can be used together.
Aggregates validate matching rows and require finite Decimal values. Sums preserve
all digits; averages use at least 28 significant digits with Decimal's default
half-even rounding. Numbers use plain decimal notation without redundant trailing
fractional zeros.

Empty or duplicate headers, incorrect field counts (including filtered-out rows),
malformed CSV, invalid queries, and invalid aggregate cells produce stderr errors
and a nonzero exit status. Data row numbers count CSV records, with the header as
row 1; CSV syntax errors report physical line numbers. Files are opened read-only.
