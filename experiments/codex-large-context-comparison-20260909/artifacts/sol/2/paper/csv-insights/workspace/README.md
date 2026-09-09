# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV records and computing grouped sums and averages with exact decimal input.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output. Filters are exact string comparisons and repeated
filters are combined with AND. Values may contain `=`; the first `=` separates
the column name from the value.

Examples:

```sh
python3 main.py sales.csv --where region=North
python3 main.py sales.csv --group-by region --sum revenue --avg units --output csv
```

`--sum` and `--avg` may be used together or separately, and require
`--group-by`. Groups are sorted by their exact string value. Aggregate values
are emitted as plain minimal decimal strings, avoiding binary floating-point
artifacts.

The input must be UTF-8 RFC-style CSV with a non-empty, unique header. Invalid
row widths, malformed CSV, unknown columns, malformed filters, and blank or
invalid aggregate values are reported on stderr with a non-zero exit status.
The input file is opened read-only and is never modified.
