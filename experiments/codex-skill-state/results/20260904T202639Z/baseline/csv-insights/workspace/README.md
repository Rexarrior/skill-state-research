# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV files and
calculating grouped sums and averages.

```bash
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons; repeated `--where` options combine with
AND. With no `--sum` or `--avg`, matching input rows are returned in their
original order. Aggregations require `--group-by`, use decimal arithmetic, and
sort groups lexicographically. JSON is the default output format and represents
all CSV cells and aggregate values as strings. Use `--output csv` for an
RFC-compatible CSV result.

Examples:

```bash
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where active=yes --output csv
```

Malformed CSV, invalid numbers, invalid filters, and unknown columns produce a
non-zero exit status and a diagnostic on stderr. The input file is only opened
for reading.

Run the self-tests with:

```bash
python3 -m unittest -v
```
