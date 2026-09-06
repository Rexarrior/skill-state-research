# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV data and
calculating grouped sums and averages with exact decimal arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] \
  [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Filters are exact string comparisons and repeated
filters are combined with AND. `--sum` and `--avg` may be repeated, but require
`--group-by`; aggregate values are emitted as plain decimal strings. CSV input
and output support standard quoting, including commas and embedded newlines.

Example:

```sh
python3 main.py sales.csv --where region=East \
  --group-by product --sum revenue --avg units --output csv
```

Run the self-tests with:

```sh
python3 -m unittest -v
```
