# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV records and
computing grouped sums and averages with exact decimal arithmetic.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters combine with AND.
Aggregation requires `--group-by`; `--sum` and `--avg` may each be repeated.
Output defaults to JSON. For example:

```sh
python3 main.py sales.csv --where region=west --group-by product \
  --sum revenue --avg units --output csv
```

The input must be UTF-8 RFC-style CSV with a non-empty, unique header and the
same number of fields in every record. Invalid numeric values, unknown columns,
and malformed input produce a non-zero exit status and a message on stderr.

Run the self-tests with:

```sh
python3 -m unittest -v
```
