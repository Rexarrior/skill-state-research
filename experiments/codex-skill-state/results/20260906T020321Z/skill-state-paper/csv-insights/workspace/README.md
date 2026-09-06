# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV data and
computing grouped sums and averages with exact decimal arithmetic.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters may be repeated and are combined with AND. Comparisons are exact and
case-sensitive. Without aggregation, matching rows are emitted in their input
order. `--sum` and `--avg` require `--group-by`; they may be used separately or
together. Groups are sorted lexicographically.

JSON (the default) is an array of objects. CSV output includes a header:

```console
python3 main.py sales.csv --where region=West --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg revenue
```

Input must be UTF-8 RFC-style CSV with non-empty, unique headers and a
consistent number of fields. Invalid input, unknown columns, malformed filters,
and invalid numeric cells produce a descriptive error on stderr and a non-zero
exit status. Aggregate values are emitted as exact, plain decimal strings.
