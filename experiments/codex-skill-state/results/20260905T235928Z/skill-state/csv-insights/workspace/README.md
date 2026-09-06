# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV files and
calculating grouped sums and averages.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Repeated `--where` filters use exact string matching
and are combined with AND. Aggregation requires `--group-by`; grouped output is
sorted by the group value and decimal results are emitted as strings so their
precision is preserved.

Examples:

```console
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The input must be UTF-8 CSV with a non-empty, unique header and the same number
of fields in every row. Quoted commas and embedded newlines are supported.
Invalid arguments or input produce a useful message on stderr and a non-zero
exit status. The input file is opened read-only and is never modified.
