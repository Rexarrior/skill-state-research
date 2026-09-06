# CSV Insights

`main.py` is a dependency-free Python 3.11+ command-line tool for filtering CSV
files and calculating grouped sums and averages with exact decimal arithmetic.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                         [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

JSON is the default output format. Repeat `--where` to combine exact-string
filters with AND. Aggregation requires `--group-by`, plus `--sum`, `--avg`, or
both. Aggregate values are emitted as decimal strings so precision is preserved.

Examples:

```bash
python3 main.py sales.csv --where region=North
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where status=paid --output csv
```

The parser supports quoted commas and embedded newlines. It rejects empty or
duplicate headers, inconsistent row widths, unknown columns, malformed filters,
and blank or invalid cells used in numeric aggregation. The input file is opened
read-only and is never modified.
