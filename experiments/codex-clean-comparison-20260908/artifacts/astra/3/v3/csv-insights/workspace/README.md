# CSV Insights

Dependency-free CSV analytics for Python 3.11+.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
python3 main.py sales.csv --where region=West --group-by product --sum revenue --avg revenue
python3 main.py sales.csv --where 'product=Tea, green' --output csv
```

JSON is the default. Values, including aggregate results, are strings. Filters
match exact strings and combine with AND; split occurs at the first `=`, so
values may contain `=` or be empty. Without aggregates, filtered rows retain input order, including when
`--group-by` is supplied. Aggregates emit sorted groups with `sum_COLUMN` and/or
`avg_COLUMN`. Both aggregates require grouping. Empty results are `[]` in JSON
or a header alone in CSV.

Input is UTF-8 (an optional BOM is accepted), with CSV quoting for commas,
quotes, and embedded newlines. Headers must be unique and nonblank. Every row
must match the header width, even when filtered out. Numeric validation applies
to retained rows: blank, invalid, and nonfinite numbers are rejected. Error row
numbers count CSV records, with the header as row 1; CSV syntax errors identify
physical lines. Errors go to stderr and return a nonzero exit status.

Sums use exact Decimal arithmetic. Averages use at least 28 significant digits
(round half even), or the sum's coefficient length if larger; repeating averages
are rounded. Results use plain decimal strings without redundant fractional
zeros. A group header that collides with an aggregate header is rejected.
The input file is opened only for reading; results go to stdout.

Run self-tests:

```sh
python3 -m unittest discover -v
```
