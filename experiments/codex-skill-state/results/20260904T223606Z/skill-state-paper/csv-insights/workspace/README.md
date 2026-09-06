# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating RFC-4180 CSV files.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

By default, filtered rows are emitted as a JSON array in input order. Repeating
`--where` applies exact-string filters with AND semantics. Aggregation requires
`--group-by`; its rows are sorted by group value and numeric calculations use
`decimal.Decimal`.

Examples:

```sh
python3 main.py sales.csv --where region=EU
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The input is read only. Invalid CSV structure, duplicate or empty headers,
unknown columns, invalid filters, and invalid numeric aggregation values produce
a non-zero exit status and a diagnostic on standard error.
