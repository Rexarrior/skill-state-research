# CSV Insights

A dependency-free Python 3.11+ CLI for CSV filtering and grouped analytics.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
python3 main.py sales.csv --where region=West --group-by product --sum revenue --avg revenue
python3 main.py sales.csv --where 'product=Tea, green' --output csv
```

Input is UTF-8 CSV (an optional UTF-8 BOM is accepted). Quoted commas,
quotes, and embedded newlines are supported. Headers must be non-empty and
unique; every record must have the same number of fields as the header.
The input is opened read-only.

Filters compare exact strings and combine with AND. An empty filter value is
allowed; values may contain `=`. Without `--sum` or `--avg`, matching rows stay
in input order (`--group-by` alone does not aggregate).

Aggregations require `--group-by`, sort groups lexicographically, and emit the
group column followed by `sum_COLUMN` and/or `avg_COLUMN`. Numeric cells in
matching rows must be non-blank, finite Decimal values. Sums preserve all digits;
averages use at least 28 significant decimal digits with half-even rounding.
Results use plain decimal strings without redundant fractional zeros. A group
column that collides with a generated result column is rejected.

Output defaults to a JSON array; all values, including aggregates, are strings.
CSV output always includes a header and uses standard quoting and CRLF record
endings. No matches produce `[]` in JSON or just the header in CSV.
Invalid arguments or input produce a nonzero exit status and a diagnostic on
stderr. Row numbers count CSV records, starting with header row 1; CSV syntax
errors report physical line numbers. All rows are structurally checked even
when filtered out, and input validation finishes before any result is emitted.
Results and group totals are held in memory.

Run the self-tests:

```sh
python3 -m unittest discover -s tests -v
```
