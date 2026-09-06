# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV files and
calculating grouped sums and averages with decimal arithmetic.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                          [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters combine with AND.
Without aggregation, matching rows are emitted in their original order. `--sum`
and `--avg` may each be repeated, and require `--group-by`. Output defaults to
JSON; select RFC-compatible CSV with `--output csv`.

Examples:

```sh
python3 main.py sales.csv --where region=North
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Input must be UTF-8 CSV with a non-empty, unique header and a consistent field
count. Invalid or blank numeric cells in selected rows are reported with their
row and column. The input file is only read and is never modified.

Run the self-tests with:

```sh
python3 -m unittest -v
```
