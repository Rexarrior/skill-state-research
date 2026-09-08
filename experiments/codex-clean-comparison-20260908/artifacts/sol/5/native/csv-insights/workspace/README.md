# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating CSV data. It reads CSV with standard RFC-style quoting,
including quoted commas and embedded newlines, and never changes the input
file.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Filters are exact string comparisons and repeated
filters are combined with AND. Without aggregation, matching rows retain input
order. `--sum` and `--avg` require `--group-by`; each option may be repeated for
additional numeric columns. Aggregates use decimal arithmetic and groups are
sorted by their exact string value.

Examples:

```console
python3 main.py sales.csv --where 'region=East' --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg units
```

Invalid headers, uneven rows, unknown columns, malformed filters, and invalid
numeric cells produce a diagnostic on stderr and a non-zero exit status.

Run the self-tests with:

```console
python3 -m unittest -v
```
