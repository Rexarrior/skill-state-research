# CSV Insights

CSV Insights is a dependency-free command-line tool for filtering and aggregating
UTF-8 CSV files with Python 3.11 or newer. It uses Python's RFC-aware CSV parser and
`Decimal` arithmetic for numeric results.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Without `--sum` or `--avg`, matching rows are emitted in
their original order. Repeat `--where` for exact-string AND filters:

```sh
python3 main.py sales.csv --where region=North --where status=paid --output csv
```

Aggregations require `--group-by`; `--sum` and `--avg` may be used separately or
together. Groups are sorted lexicographically and numeric results are represented
as plain decimal strings:

```sh
python3 main.py sales.csv --group-by region --sum amount --avg amount
```

The command exits non-zero and writes a useful message to standard error for bad
arguments, malformed filters or CSV, unknown columns, inconsistent row widths,
and blank or invalid numeric cells. The input file is only opened for reading.
