# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV data and calculating grouped sums and averages. It uses the standard
library CSV parser, so quoted commas and embedded newlines are supported.

## Usage

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters compare exact strings and multiple `--where` options are combined with
AND. With no aggregation, matching rows are emitted in their original order.
`--sum` and `--avg` require `--group-by`; both can be used together. Aggregates
are calculated with `decimal.Decimal`, sorted by group value, and emitted as
plain decimal strings. The default output format is JSON.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --group-by region --sum revenue --output csv
```

Malformed CSV, invalid numeric values, unknown columns, and invalid arguments
produce a useful error on standard error and a non-zero exit status. The input
file is opened read-only and is never modified.
