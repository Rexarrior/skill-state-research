# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV data and calculating grouped sums and averages with exact decimal arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Filters may be repeated and are combined with AND;
values are compared as exact strings. `--sum` and `--avg` each require
`--group-by`, and may be used together. Aggregate values in JSON are strings so
their decimal representation remains exact and free of floating-point artifacts.

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

CSV is parsed with Python's RFC-compatible standard-library parser, including
quoted commas and embedded newlines. Bad headers, inconsistent rows, unknown
columns, malformed filters, and invalid numeric cells produce a non-zero exit
status and an explanatory message on standard error. The input is only read.

Run the self-tests with:

```sh
python3 -m unittest -v
```
