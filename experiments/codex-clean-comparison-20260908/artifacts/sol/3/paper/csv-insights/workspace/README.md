# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating CSV data. It uses the standard CSV parser (including quoted
commas and embedded newlines) and exact decimal arithmetic.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Without aggregation, matching rows retain their input
order. Repeat `--where` to combine exact-string filters with AND. `--sum` and
`--avg` may each be repeated, but require `--group-by`; aggregated groups are
sorted by the group value.

Example:

```console
python3 main.py sales.csv --where status=paid --group-by region \
  --sum amount --avg amount --output csv
```

Malformed CSV, invalid row widths, invalid numeric cells, bad filters, and
unknown columns produce a useful error on standard error and a non-zero exit.
