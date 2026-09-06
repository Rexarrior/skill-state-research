# CSV Insights

Dependency-free Python 3.11+ command-line filtering and aggregation for CSV files.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

The default output is JSON. Filters are exact string matches and combine with
AND. Aggregation needs `--group-by`; its groups are lexicographically sorted.
Numeric aggregation uses `decimal.Decimal`, so values are exact decimals.

```sh
python3 main.py sales.csv --where region=EU --group-by product --sum amount --avg amount
python3 main.py sales.csv --where status=paid --output csv
```

Input CSV must have unique, non-empty headers and every row must contain the
same number of fields as the header. The input file is read only.
