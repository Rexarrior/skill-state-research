# CSV Insights

A dependency-free Python 3.11+ CLI for filtering and aggregating UTF-8 CSV files.

```sh
python3 main.py INPUT.csv --where region=West --where status=paid
python3 main.py INPUT.csv --group-by region --sum revenue --avg revenue
python3 main.py INPUT.csv --where status=paid --output csv
python3 -m unittest discover -v
```

Filters compare exact strings and combine with AND. Split filters at the first
`=`; an empty value is allowed. Quote shell arguments containing spaces.
The default output is a JSON array; all values, including decimal aggregates,
are strings. CSV output includes a header, even when no rows match.

Without grouping, matching rows retain input order. Grouping produces one row
per distinct group, sorted lexicographically. `--group-by` alone lists distinct
groups. `--sum` and `--avg` require grouping and produce `sum_COLUMN` and
`avg_COLUMN` fields. Sums are exact; averages use Decimal arithmetic with at
least 28 significant digits and round half to even for repeating fractions.
Numbers render without exponents or unnecessary trailing zeros.

Headers must be non-empty and unique. Every record must have the header's field
count, even if filtered out. Aggregate numeric cells in matching rows must be
finite decimal numbers; surrounding numeric whitespace and scientific notation
are accepted. Errors go to stderr with a nonzero exit status. Numeric errors
identify the column and logical CSV row (header is row 1; embedded newlines do
not add rows). The input is opened read-only and never modified.
