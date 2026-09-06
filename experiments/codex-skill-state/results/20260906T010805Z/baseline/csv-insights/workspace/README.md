# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV data and
calculating grouped sums and averages with exact decimal arithmetic.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                          [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters are combined with
AND. Aggregations require `--group-by`; results are ordered by group value.
Output defaults to JSON. The input is read as UTF-8 and is never modified.

Examples:

```bash
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by team --sum revenue --avg units --output csv
```

Run the self-tests with:

```bash
python3 -m unittest -v
```
