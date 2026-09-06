# CSV Insights

`main.py` is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating RFC-4180 CSV files.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters use exact string matches and combine with AND. Without aggregates, the
tool emits the matching input rows in their original order. Aggregates require
`--group-by`; groups are sorted lexicographically. Numeric calculations use
`decimal.Decimal`, and aggregate values are rendered as minimal decimal strings.

Examples:

```sh
python3 main.py sales.csv --where region=west --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg revenue
```

The program validates headers, record widths, filters, referenced columns, and
numeric aggregate cells. Errors are printed to stderr and return a non-zero exit
status; the input file is read only.

Run the self-tests with:

```sh
python3 -m unittest -v
```
