# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating
CSV data. It reads standard RFC-style CSV, including quoted commas and embedded
newlines, and never changes the input file.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Repeat `--where` to combine exact-string filters with
AND. Aggregations require `--group-by`; `--sum` and `--avg` may be used together.
Groups are sorted by their exact text value, and decimal results are emitted as
plain strings so their precision is preserved.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where status=paid --group-by team --sum amount --output csv
```

Malformed CSV, invalid numeric cells, unknown columns, and invalid command-line
combinations produce a useful error on stderr and a non-zero exit status.
