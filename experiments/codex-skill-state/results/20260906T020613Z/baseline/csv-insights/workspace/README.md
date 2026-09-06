# CSV Insights

`main.py` is a dependency-free Python 3.11+ command-line tool for filtering and
aggregating RFC-style CSV files.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                          [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated `--where` options are joined
with AND. `--sum` and `--avg` require `--group-by`; aggregates use decimal
arithmetic and are ordered by group value. Output defaults to JSON.

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Input errors are reported on stderr and return a non-zero exit status. The input
file is opened read-only and is never modified.

Run the self-tests with:

```sh
python3 -m unittest -v
```
