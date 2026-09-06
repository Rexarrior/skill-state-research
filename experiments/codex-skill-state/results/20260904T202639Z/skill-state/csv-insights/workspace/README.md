# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV data and calculating grouped sums and averages with exact decimal arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Output defaults to JSON. Filters are exact string comparisons and repeated
filters are combined with AND. `--sum` and `--avg` may each be repeated, and
require `--group-by`.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

The input must be UTF-8 RFC-style CSV with a non-empty, unique header and the
same number of fields in every row. Invalid input or arguments produce a useful
message on stderr and a non-zero exit status. The input file is only read.
