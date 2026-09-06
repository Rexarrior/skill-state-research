# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV files and
computing grouped decimal sums and averages.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

`--where` is repeatable and all filters must match exactly. `--sum` and `--avg`
are also repeatable, but require `--group-by`. Output defaults to JSON; use
`--output csv` for CSV. Aggregate values are calculated with `Decimal`, groups
are sorted lexicographically, and malformed data produces a non-zero exit.

Example:

```console
python3 main.py sales.csv --where region=west --group-by product \
  --sum revenue --avg units --output csv
```

Run the self-tests with:

```console
python3 -m unittest -v
```
