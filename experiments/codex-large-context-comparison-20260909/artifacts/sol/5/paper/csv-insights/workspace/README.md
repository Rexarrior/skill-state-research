# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating RFC-style CSV files.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Repeat `--where` to combine exact-string filters
with AND. `--sum` and `--avg` may also be repeated, and require `--group-by`.
For example:

```console
python3 main.py sales.csv --where region=West --group-by product \
  --sum revenue --avg units --output csv
```

The tool validates headers and row widths before producing output. Aggregates
use decimal arithmetic; invalid or blank numeric cells are reported with their
logical CSV row and column. The input file is opened read-only.

Run the self-tests with:

```console
python3 -m unittest -v
```
