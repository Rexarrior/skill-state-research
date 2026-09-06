# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and grouped CSV
analytics. It reads RFC-style CSV correctly, including quoted commas and
embedded newlines, and uses `decimal.Decimal` for numeric calculations.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Repeated `--where` options use exact string matching
and combine with AND. `--sum` and `--avg` require `--group-by`; both may be used
together. With no aggregation, filtered rows retain their input order.

Examples:

```console
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg revenue
python3 main.py sales.csv --group-by region --sum revenue --output csv
```

Invalid CSV structure, headers, filters, columns, and numeric cells are reported
on stderr and produce a non-zero exit status. The input file is only opened for
reading.

Run the self-tests with:

```console
python3 -m unittest -v
```
