# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering CSV records and calculating grouped sums and averages. It reads CSV using RFC-compatible quoting, including quoted commas and embedded newlines, and never changes the input file.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Examples:

```sh
# Filter records; multiple filters are combined with AND.
python3 main.py sales.csv --where region=west --where status=paid

# Calculate exact decimal aggregates, sorted by region.
python3 main.py sales.csv --group-by region --sum amount --avg amount --output csv
```

The default output is compact JSON. `--output csv` writes a header and RFC-compliant CSV records. Unaggregated values and aggregate values are represented as strings in JSON so that CSV text and decimal precision are preserved. `--sum` and `--avg` each accept one column and require `--group-by`; they may be used together.

Empty or duplicate headers, uneven rows, unknown columns, malformed filters, malformed CSV, and blank, non-finite, or invalid numeric values are reported on stderr with a non-zero exit status.
