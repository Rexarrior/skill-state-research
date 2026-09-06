# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV records and calculating grouped sums and averages.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                          [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Filters compare exact text and multiple filters are combined with AND. `--sum`
and `--avg` may each be repeated and require `--group-by`. Output defaults to
JSON; aggregated decimal values are emitted as strings so their exact decimal
representation is preserved. CSV input must be UTF-8 with a non-empty, unique
header row and the same number of fields in every record.
