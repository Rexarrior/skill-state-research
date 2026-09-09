# CSV Insights

A dependency-free Python 3.11+ command-line tool. Run:

```sh
python3 main.py INPUT.csv --where region=West --where status=active
python3 main.py INPUT.csv --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

JSON is the default output; `--output csv` includes a header. All output values
are strings, including decimal aggregates. Filters compare exact strings, combine
with AND, and split at the first `=` (empty values are allowed). Without `--sum`
or `--avg`, filtered rows retain input order, including when `--group-by` is given.
Aggregates require `--group-by` and sort groups lexicographically.

Input is UTF-8 CSV with quoted commas and embedded newlines supported. Headers
must be nonempty and unique, and every record must have the correct field count.
Numeric cells in matching records must be finite decimals. Sums are exact;
averages use at least 28 significant decimal digits and half-even rounding when
necessary. Decimal output uses plain notation with no unnecessary trailing zeros.
Row numbers count CSV records, with the header as row 1.

Errors go to stderr with a nonzero exit status. Input is opened read-only, and
validation completes before any results are emitted. Empty results produce `[]`
in JSON or only the output header in CSV.
