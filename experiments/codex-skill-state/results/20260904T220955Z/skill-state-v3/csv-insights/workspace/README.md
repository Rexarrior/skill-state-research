# CSV Insights

Dependency-free Python 3.11+ CLI for filtering and grouping RFC-4180 CSV data.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

By default, it writes matching rows as a JSON array. `--where` accepts exact
string matches and can be repeated; filters combine with AND. Aggregations use
`decimal.Decimal`, require `--group-by`, and produce sorted group results.

Examples:

```sh
python3 main.py sales.csv --where region=EU --output csv
python3 main.py sales.csv --group-by region --sum amount --avg amount
```

Malformed CSV, duplicate or blank headers, unknown columns, invalid filters, and
invalid aggregation values produce a non-zero exit status and an error on stderr.
