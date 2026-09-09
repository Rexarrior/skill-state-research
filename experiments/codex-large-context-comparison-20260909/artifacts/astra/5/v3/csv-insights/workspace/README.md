# CSV Insights

A dependency-free Python 3.11+ CLI for filtering CSV records and calculating grouped sums and averages.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg revenue --output csv
python3 main.py sales.csv --where region=West --where status=paid --output json
```

JSON is the default output. All values, including aggregate decimals, are strings. Repeated filters combine with AND and match exact strings; values may contain `=`. Quote shell arguments containing spaces. Input is UTF-8 CSV, with quoted commas and embedded newlines supported. Headers must be non-empty and unique, and every record must match the header width.

Unaggregated rows retain input order. `--sum` and `--avg` require `--group-by`; grouping alone emits distinct group values. Groups sort lexicographically. Aggregates are named `sum_COLUMN` and `avg_COLUMN`; conflicting output names are rejected. Empty results produce `[]` in JSON or just the CSV header.

Numeric cells in matching records must be finite decimal numbers (scientific notation and surrounding whitespace are accepted). Sums preserve decimal precision; averages use at least 28 significant digits with Decimal's half-even rounding for nonterminating results. Output uses plain decimal strings without unnecessary trailing zeros. Error row numbers count CSV records, with the header as row 1, even for multiline records. All record widths are validated, including filtered-out records. Errors go to stderr with a nonzero exit status. The input is opened read-only.

Run the self-tests:

```sh
python3 -m unittest discover -v
```
