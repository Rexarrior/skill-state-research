# CSV Insights

`CSV Insights` is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating CSV data. It uses Python's CSV parser (including quoted commas
and embedded newlines) and `decimal.Decimal` for numeric calculations.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Repeated `--where` options are exact-string filters
combined with AND. `--sum` and `--avg` require `--group-by`; grouped output is
sorted by the group value.

Examples:

```console
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Malformed CSV, invalid numbers, unknown columns, and invalid arguments produce a
message on standard error and a non-zero exit status. The input file is only
opened for reading.

Run the self-tests with:

```console
python3 -m unittest -v
```
