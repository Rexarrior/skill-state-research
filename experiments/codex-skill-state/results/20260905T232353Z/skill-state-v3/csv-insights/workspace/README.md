# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating UTF-8 CSV data. It uses the standard library CSV parser, so
quoted commas and embedded newlines are supported.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters combine with AND.
Without aggregation, matching input rows are emitted in their original order.
`--sum` and `--avg` may each be repeated, require `--group-by`, and use exact
decimal arithmetic. Groups are sorted by their string value.

Examples:

```sh
python3 main.py sales.csv --where region=East --output json
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

JSON is the default output. Errors such as invalid headers, uneven rows,
unknown columns, malformed filters, and invalid numeric cells are written to
standard error and return a non-zero exit status. The input file is opened
read-only and is never modified.
