# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV data and calculating grouped sums and averages with exact decimal arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

`--where` is repeatable and filters combine with AND. Without `--sum` or
`--avg`, matching rows are emitted in input order. Aggregations require
`--group-by`, sort groups lexicographically, and can calculate a sum, an
average, or both. JSON is the default output format.

Examples:

```sh
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Invalid CSV structure, headers, columns, filters, and numeric values are
reported on stderr and return a non-zero exit status. The input file is only
opened for reading.

Run the self-tests with:

```sh
python3 -m unittest discover -s tests -v
```
