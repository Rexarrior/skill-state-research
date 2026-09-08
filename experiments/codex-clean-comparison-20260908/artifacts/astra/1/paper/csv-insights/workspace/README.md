# CSV Insights

A dependency-free Python 3.11+ command-line CSV analytics tool.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --where status=paid --group-by region --sum revenue --avg revenue --output csv
```

Repeat `--where COLUMN=VALUE` to combine exact, case-sensitive string filters
with AND. Values may be empty or contain `=`. Quote shell arguments containing
spaces. JSON is the default output; all cell values, including aggregates, are
strings. CSV output includes a header, even when no rows match.

`--sum` and `--avg` require `--group-by`. Grouping alone returns unique group
values. Groups sort lexicographically; ungrouped rows retain input order.
Aggregates are named `sum_COLUMN` and `avg_COLUMN`. Sums use exact decimal
arithmetic; averages use at least 28 significant digits (round half even when
necessary). Decimal strings have no exponent or redundant fractional zeros.
Numeric cells accept surrounding whitespace and scientific notation, but not
blanks, NaN, infinity, or underscores. Only matching rows are aggregated.

Input is UTF-8 (an optional BOM is accepted), with standard CSV quoting,
including embedded commas and newlines. Headers must be non-empty and unique.
All rows are checked for field count, including filtered-out rows. Errors go to
stderr with a nonzero exit status; row numbers count CSV records, with the
header as row 1. Invalid CSV quoting is checked using Python's strict CSV
reader. Conflicting generated output names are errors. Input is opened only
for reading. Results are held in memory and emitted after validation.

Run the self-tests:

```sh
python3 -m unittest -v
```
