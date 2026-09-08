# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
RFC-style CSV files and calculating grouped sums and averages with exact decimal
arithmetic.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Filters are repeatable, use exact string comparison,
and combine with AND. Aggregation requires `--group-by`; groups are emitted in
lexicographic order and aggregate values are exact decimal strings.

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Malformed CSV, inconsistent row widths, invalid numeric values, bad filters,
and unknown columns produce a useful error on standard error and a non-zero exit
status. The input file is only opened for reading.
