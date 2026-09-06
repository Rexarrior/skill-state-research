# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV files and calculating grouped sums and averages with exact decimal input.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Repeat `--where`, or put several expressions after
one `--where`, to combine exact-string filters with AND. Aggregation requires
`--group-by` and at least one of `--sum` or `--avg`.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The input is read as UTF-8 RFC-style CSV and is never modified. Numeric output
is emitted as minimal decimal text, avoiding binary floating-point artifacts.
Errors are written to stderr and return a non-zero exit status.

Run the self-tests with:

```sh
python3 -m unittest discover -s tests -v
```
