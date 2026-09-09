# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV data and computing grouped sums and averages.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Repeat `--where` to combine exact-string filters with AND. `--sum` and `--avg` may also be repeated, and require `--group-by`.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

CSV is read as UTF-8 using standard RFC-style quoting. Invalid headers, uneven rows, unknown columns, malformed filters, and invalid aggregate values are reported on stderr with a non-zero exit status. The input file is only read, never modified.

Run the self-tests with:

```sh
python3 -m unittest -v
```
