# CSV Insights

CSV Insights is a dependency-free command-line tool for filtering and grouped
analysis of RFC-style CSV files. It requires Python 3.11 or newer and never
modifies its input.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated `--where` options combine
with AND. Without aggregation, matching records retain input order. `--sum`
and `--avg` require `--group-by`; they may be used separately or together.
Groups are sorted by their exact string value. JSON is the default output
format, while `--output csv` writes a header and RFC-compliant quoted fields.

Examples:

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --where status=paid --group-by owner --sum amount --output csv
```

Malformed CSV, invalid row widths, duplicate or empty headers, unknown columns,
bad filters, and invalid numeric cells produce a useful error on stderr and a
non-zero exit status. Aggregations use decimal arithmetic rather than binary
floating point.

Run the included self-tests with:

```sh
python3 -m unittest -v
```
