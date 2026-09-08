# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating RFC-style CSV files. It reads the input without modifying it and
writes either JSON (the default) or CSV to standard output.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters are combined with AND.
For example:

```console
python3 main.py sales.csv --where region=West --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg units
```

`--sum` and `--avg` require `--group-by`; each option may be repeated. Numeric
aggregation uses decimal arithmetic. Invalid CSV, unknown columns, malformed
filters, and blank or invalid numeric values are reported on standard error with
a non-zero exit status.
