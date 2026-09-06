# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV records and calculating grouped sums and averages with exact decimal
arithmetic.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters are combined with
AND. `--sum` and `--avg` are repeatable and require `--group-by`. Output defaults
to JSON; use `--output csv` for RFC-compliant CSV. With no aggregation flags,
matching input rows are returned in their original order.

Examples:

```console
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Input must be UTF-8 CSV with a non-empty, unique header and a consistent field
count. Invalid or blank numeric cells cause a non-zero exit and identify their
record and column.

Run the self-tests with:

```console
python3 -m unittest -v
```
