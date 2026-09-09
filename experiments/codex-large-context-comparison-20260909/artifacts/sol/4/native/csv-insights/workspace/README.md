# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV records and calculating grouped sums and averages.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output format. Filters are exact string comparisons and
multiple filters are combined with AND. Aggregates require `--group-by`; their
values are emitted as exact decimal strings, with groups sorted by group value.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --group-by region --sum revenue --output csv
```

The parser supports quoted commas and embedded newlines. Invalid headers, uneven
rows, unknown columns, malformed filters, and invalid aggregate values are
reported on standard error with a non-zero exit status. The input file is only
opened for reading.

Run the self-tests with:

```sh
python3 -m unittest -v
```
