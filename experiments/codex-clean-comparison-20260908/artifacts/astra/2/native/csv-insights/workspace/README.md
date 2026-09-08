# CSV Insights

A dependency-free Python 3.11+ CLI for filtering UTF-8 CSV files and computing
grouped decimal totals and averages. Input files are opened read-only.

```sh
python3 main.py INPUT.csv --where region=West --where status=paid
python3 main.py INPUT.csv --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

`--where COLUMN=VALUE` is repeatable: all exact, case-sensitive string matches
must pass. Values can be empty or contain `=`; quote shell arguments containing
spaces. Without aggregation, matching rows retain input order and original strings.
Use `--group-by COLUMN` with `--sum COLUMN`, `--avg COLUMN`, or both to emit
aggregates sorted by group value. Both aggregates require grouping;
`--group-by` alone leaves matching rows unchanged.

Output defaults to a JSON array. Aggregate values are plain decimal **strings**
in JSON as well as CSV, under `sum_<column>` and `avg_<column>` keys. Sums are
exact; averages use decimal arithmetic with at least 28 significant digits
(half-even rounding when necessary). Trailing fractional zeroes are omitted.
An empty result is `[]` in JSON or a header-only CSV.

CSV supports quoted commas, escaped quotes, and embedded newlines. Headers must
be non-empty and unique; every record must have the expected number of fields.
Numeric cells in matching rows must be finite, non-blank decimals. Errors go to
stderr with a nonzero exit code; numeric errors identify the column and logical
record number, counting the header as record 1. Structural validation covers
filtered-out rows too. An optional UTF-8 BOM is accepted.
