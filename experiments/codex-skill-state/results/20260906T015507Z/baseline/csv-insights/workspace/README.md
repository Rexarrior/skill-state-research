# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating RFC-style CSV files.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output format. Repeat `--where` to combine exact string
filters with AND. `--sum` and `--avg` require `--group-by`; they may be used
together. Aggregated groups are sorted by their group value.

Examples:

```bash
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

Errors such as malformed CSV, inconsistent row widths, unknown columns, and
invalid numeric cells are reported on stderr with a non-zero exit status. The
input file is opened read-only and is never modified.

Run the self-tests with:

```bash
python3 -m unittest -v
```
