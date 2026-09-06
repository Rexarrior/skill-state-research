# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating
RFC-style CSV data without modifying the input file.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

`--where` is repeatable; all filters must match exactly. Aggregations require
`--group-by`, and `--sum` and `--avg` may be used separately or together.
The default output is JSON. Aggregate numbers are emitted as decimal strings so
their exact values are preserved; CSV output uses the same minimal decimal text.

Examples:

```console
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --group-by region --sum revenue --output csv
```

Malformed CSV, invalid row widths, duplicate or empty headers, unknown columns,
and invalid numeric cells are reported on standard error with a non-zero exit
status.
