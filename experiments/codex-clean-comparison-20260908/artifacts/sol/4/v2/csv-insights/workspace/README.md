# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering CSV data and computing grouped decimal sums and averages.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Filters are exact string comparisons and repeated filters combine with AND. Without `--sum` or `--avg`, matching rows are emitted in input order. Aggregations require `--group-by`; groups are sorted lexicographically. Both `--sum` and `--avg` may be repeated.

Examples:

```console
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The parser supports quoted commas and embedded newlines. Invalid headers, uneven rows, unknown columns, malformed filters, and blank or invalid aggregate values produce a useful error and a nonzero exit status. The input file is only opened for reading.

Run the self-tests with:

```console
python3 -m unittest -v
```
