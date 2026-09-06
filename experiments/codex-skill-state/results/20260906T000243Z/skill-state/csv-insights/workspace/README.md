# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering CSV files and
calculating grouped sums and averages with exact decimal arithmetic.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters are combined with
AND. JSON is the default output format. `--sum` and `--avg` require
`--group-by`; they may be used individually or together.

Examples:

```sh
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where status=paid --output csv
```

The input must be UTF-8 RFC-style CSV with a non-empty, unique header and a
consistent number of fields per record. Numeric aggregation uses
`decimal.Decimal`; blank, invalid, NaN, and infinite numeric values are
reported as errors. The input file is opened read-only and is never modified.
