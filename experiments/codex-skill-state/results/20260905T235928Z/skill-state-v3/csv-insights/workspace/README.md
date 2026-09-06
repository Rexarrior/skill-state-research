# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV records and calculating grouped sums and averages.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters compare exact strings and multiple `--where` options combine with AND.
The default output is JSON. Use `--output csv` for CSV. Aggregations require a
grouping column; `--sum` and `--avg` may be used separately or together.

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where 'status=paid' --output csv
```

The input must be UTF-8 RFC-style CSV with a non-empty, unique header and a
consistent number of fields. Aggregate cells must contain finite decimal
numbers. Validation failures are reported on stderr and return a non-zero exit
status. The input file is only read and is never modified.
