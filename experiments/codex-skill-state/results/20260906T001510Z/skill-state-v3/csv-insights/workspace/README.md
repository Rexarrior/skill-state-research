# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating CSV data. It reads RFC-style CSV safely, uses exact decimal
arithmetic, and writes JSON or CSV to standard output.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

`--where` is repeatable; all filters must match exactly. `--sum` and `--avg`
require `--group-by`. JSON is the default output format. Results go to stdout,
while invalid arguments or data produce a descriptive error on stderr and a
non-zero exit status. The input file is only opened for reading.
