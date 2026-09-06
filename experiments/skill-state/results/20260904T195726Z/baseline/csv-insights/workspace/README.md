# CSV Insights

A dependency-free Python 3.11+ CLI for filtering and aggregating CSV files.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Repeated `--where` filters use exact string matching
and combine with AND. `--sum` and `--avg` require `--group-by`; both can be used
together. Aggregated numbers are emitted as plain decimal strings.

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Malformed CSV, invalid numeric cells, unknown columns, and invalid arguments are
reported on stderr and return a non-zero status. The input file is only read.

Run the self-tests with:

```sh
python3 -m unittest discover -s tests -v
```
