# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
and aggregating CSV data. It reads standards-compatible quoted fields (including
embedded commas and newlines), validates every record, and performs numeric
work with `decimal.Decimal`.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                        [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters combine with AND.
Without aggregation, matching rows retain input order. `--sum` and `--avg`
require `--group-by`; grouped output is sorted by the group value.

Examples:

```sh
python3 main.py sales.csv --where region=East
python3 main.py sales.csv --group-by region --sum revenue --avg revenue --output csv
```

JSON is the default output. Aggregate values are emitted as plain decimal
strings, preserving decimal accuracy without conversion through binary floats.
Errors are reported on stderr and return a non-zero status. The input file is
opened read-only and is never modified.
