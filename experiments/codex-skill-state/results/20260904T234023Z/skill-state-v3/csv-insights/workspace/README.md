# CSV Insights

Dependency-free Python 3.11+ CLI for filtering and grouping RFC-4180 CSV data.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string matches and are combined with AND. Without aggregation,
matching rows retain input order. Aggregation requires `--group-by`; result groups
are sorted by their group value. Output defaults to JSON and can be emitted as CSV.

```sh
python3 main.py sales.csv --where region=EU --group-by product --sum revenue --avg revenue
```

Malformed CSV, invalid headers, unknown columns, malformed filters, and non-numeric
aggregate cells produce an explanatory stderr error and a non-zero exit status.
