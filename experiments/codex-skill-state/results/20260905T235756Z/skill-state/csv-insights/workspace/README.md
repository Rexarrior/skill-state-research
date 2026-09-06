# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and aggregating
CSV files.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Filters are exact string comparisons and repeated
filters are combined with AND. `--sum` and `--avg` require `--group-by`; both
options may be repeated. Aggregates are emitted as precision-preserving minimal
decimal strings. Grouped output is sorted by the group value.

Examples:

```sh
python3 main.py sales.csv --where region=North
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Run the self-tests with:

```sh
python3 -m unittest -v
```
