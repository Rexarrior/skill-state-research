# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating CSV files. It reads RFC-style CSV (including quoted commas and
embedded newlines) and writes JSON or CSV to standard output.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters may be repeated and are combined with AND. Comparisons are exact text
comparisons. `--sum` and `--avg` may also be repeated, and require
`--group-by`. JSON is the default output format.

Examples:

```sh
python3 main.py sales.csv --where 'region=West' --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg units
```

Aggregations use decimal arithmetic. Invalid CSV, unknown columns, malformed
filters, and blank or invalid numeric values produce an explanatory error on
standard error and a non-zero exit status. The input file is only read and is
never modified.
