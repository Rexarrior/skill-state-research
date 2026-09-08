# CSV Insights

A dependency-free Python 3.11+ command-line tool for filtering and grouping CSV.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --where status=paid --group-by region --sum revenue --avg revenue
python3 main.py sales.csv --where region=West --where status=paid --output csv
python3 -m unittest discover -v
```

Input is UTF-8 (an optional BOM is accepted), with unique, non-empty headers.
Quoted commas and embedded newlines are supported. Filters compare exact strings,
combine with AND, and split at the first `=`; `--where column=` matches an empty
cell. Quote shell arguments containing spaces or special characters.

JSON is the default output: an array of objects whose values are strings. CSV
output includes a header, including when no rows match. Ungrouped rows retain
input order. `--group-by` alone emits distinct group values; `--sum` and `--avg`
require it. Groups sort lexicographically, with aggregates named `sum_COLUMN`
and `avg_COLUMN`.

Aggregates use Decimal arithmetic and plain decimal strings without trailing
fractional zeros. Sums retain all significant digits. Averages use at least 28
significant digits (more for large totals), with Decimal's half-even rounding
when necessary. Blank, invalid, and non-finite numeric values in matching rows
are errors. Row numbers count CSV records, with the header as row 1, even when
records span physical lines. Field counts are checked even on excluded rows.

Invalid arguments, unknown columns, malformed CSV, and read errors produce a
message on stderr and a nonzero exit status. Data is validated before output
begins. The input file is opened only for reading.
