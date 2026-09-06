# CSV Insights

Dependency-free Python 3.11+ command-line filtering and aggregation for RFC-4180 CSV.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Rows can be filtered with any number of exact-match `--where` options; all filters
must match. Without aggregation, selected rows retain their input order. `--sum`
and `--avg` require `--group-by`; groups are sorted by their value. Numeric
aggregation uses exact decimal arithmetic.

Examples:

```sh
python3 main.py sales.csv --where region=East --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg revenue
```

The default output is a JSON array. Invalid CSV structure, duplicate or empty
headers, bad filters, unknown columns, and invalid numeric aggregate cells are
reported to stderr with a non-zero exit status. The input file is read only.
