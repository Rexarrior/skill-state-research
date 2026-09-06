# CSV Insights

Dependency-free Python 3.11+ command-line tool for filtering and aggregating RFC-4180 CSV files.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters use exact string matches and combine with AND. Without aggregation, the filtered input rows are emitted in their original order. `--sum` and `--avg` require `--group-by`; aggregates use exact decimal arithmetic and groups are sorted by their group value.

Examples:

```sh
python3 main.py sales.csv --where region=EU --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg units
```

Errors (invalid CSV structure, unknown columns, malformed filters, and invalid numeric aggregate cells) are reported on stderr with a non-zero exit status. The input file is read only.
