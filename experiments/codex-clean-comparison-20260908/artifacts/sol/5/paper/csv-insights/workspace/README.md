# CSV Insights

`main.py` is a dependency-free Python 3.11+ command-line tool for filtering CSV
files and calculating grouped sums and averages with exact decimal arithmetic.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons, and repeated `--where` options are combined
with AND. `--sum` and `--avg` each require `--group-by`; they can be used separately
or together. Output defaults to JSON. For example:

```sh
python3 main.py sales.csv --where 'region=North' --group-by product --sum revenue
python3 main.py sales.csv --where 'status=paid' --output csv
```

The input is read as UTF-8 RFC-style CSV and is never modified. Malformed CSV,
invalid headers or row widths, unknown columns, and invalid aggregate values produce
a diagnostic on standard error and a non-zero exit status.
