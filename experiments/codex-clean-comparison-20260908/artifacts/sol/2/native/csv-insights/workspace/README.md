# CSV Insights

CSV Insights is a dependency-free command-line tool for filtering CSV data and
calculating grouped sums and averages. It requires Python 3.11 or newer.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Filters use exact string matching and repeated
filters are combined with AND. Aggregations require `--group-by`; calculations
use decimal arithmetic and results are sorted by the group value.

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Run the self-tests with:

```sh
python3 -m unittest discover -s tests -v
```
