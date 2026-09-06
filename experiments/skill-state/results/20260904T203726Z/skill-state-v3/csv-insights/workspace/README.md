# CSV Insights

Dependency-free Python 3.11+ command-line filtering and aggregation for RFC-4180-style CSV files.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

`--where` compares exact strings; multiple filters are combined with AND. Without aggregation, matching rows retain their input order. `--sum` and `--avg` require `--group-by`; groups are sorted lexicographically. Numeric aggregates use `decimal.Decimal` and are emitted as decimal strings in JSON to preserve precision.

Examples:

```sh
python3 main.py sales.csv --where region=EU --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg units
```

Invalid CSV, duplicate or blank headers, unknown columns, malformed filters, and invalid aggregate cells produce a non-zero exit status with an explanatory error on stderr. The input file is read only.
