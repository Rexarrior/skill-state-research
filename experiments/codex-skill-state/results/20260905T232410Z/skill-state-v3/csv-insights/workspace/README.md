# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV data and
calculating grouped sums and averages with exact decimal arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons; repeat `--where` to combine filters with
AND. `--sum` and `--avg` may each be repeated and require `--group-by`. Output
defaults to JSON. For example:

```sh
python3 main.py sales.csv --where region=West --group-by product \
  --sum revenue --avg units --output csv
```

The input must be UTF-8 CSV with one non-empty, unique name per header field and
the same number of fields in every record. Quoted commas and embedded newlines
are supported. Invalid input or arguments produce a message on stderr and a
non-zero exit status. The input file is only read and is never modified.
