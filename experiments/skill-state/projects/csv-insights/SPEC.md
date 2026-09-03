# CSV Insights

Build a dependency-free Python 3.11+ command-line analytics tool in `main.py`.

Invocation:

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

## Requirements

- Parse RFC-4180-style CSV with the Python standard library, including quoted commas and embedded newlines.
- Headers must be non-empty and unique. Rows with the wrong number of fields are errors.
- Multiple `--where` filters combine with AND and compare exact strings.
- Without aggregation, emit filtered rows in input order.
- `--sum` and `--avg` require `--group-by`; either or both may be provided.
- Aggregate numeric values with `decimal.Decimal`; blank or invalid numeric cells are errors that identify the row and
  column. Do not expose binary floating-point artifacts.
- Group results are sorted lexicographically by group value and use columns named `sum_<column>` / `avg_<column>`.
  Decimal output should be a plain, minimal decimal string (for example `3`, `2.5`, `0.01`).
- JSON output is an array of objects. CSV output contains a header and uses RFC-compliant quoting.
- Unknown columns, malformed filters, invalid arguments, and malformed input exit non-zero with a useful stderr message.
- Never modify the input file.

Include a concise `README.md` and run meaningful self-tests before finishing.
