# CSV Insights

Dependency-free CSV analytics for Python 3.11+.

```sh
python3 main.py sales.csv
python3 main.py sales.csv --where region=West --where status=paid
python3 main.py sales.csv --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

Output defaults to a JSON array. Use `--output csv` for CSV with a header.
All JSON values, including aggregates, are strings. Filters compare exact,
case-sensitive strings and combine with AND; values may contain `=` or be empty.
Quote arguments containing spaces in your shell.

Without grouping, matching records retain input order. `--group-by` produces
lexicographically sorted groups; alone, it lists distinct group values.
`--sum` and `--avg` require grouping and produce `sum_COLUMN` and `avg_COLUMN`.
Sums use enough decimal precision to preserve all input digits. Averages use
at least 28 significant digits and round half to even when needed. Decimal
results use plain notation without redundant fractional zeros.

Input is UTF-8 (an optional BOM is accepted). Quoted commas, escaped quotes,
and embedded newlines are supported. Headers must be non-empty and unique;
every record must have the header's field count. Numeric aggregates accept
finite decimal values, including exponent notation and surrounding whitespace.
Blank or invalid numeric values in matching rows are errors. Record numbers
in errors count the header as row 1, even with embedded newlines. Structural
validation covers all records, including filtered-out records.

Invalid input or options produce a nonzero exit status and an error on stderr.
No results are emitted before validation completes. Empty results are `[]` in
JSON or just the header in CSV. The input file is only opened for reading.
