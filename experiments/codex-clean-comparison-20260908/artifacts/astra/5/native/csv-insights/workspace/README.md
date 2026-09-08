# CSV Insights

A dependency-free Python 3.11+ command-line tool for CSV filtering and grouped
analytics. Input is opened read-only and decoded as UTF-8 (an optional BOM is
accepted).

```sh
python3 main.py INPUT.csv
python3 main.py INPUT.csv --where region=West --where status=paid --output csv
python3 main.py INPUT.csv --group-by region --sum revenue --avg revenue
```

Repeated `--where COLUMN=VALUE` filters compare exact strings and combine with
AND. Values may be empty or contain `=`; quote arguments containing shell
metacharacters or spaces. Ungrouped output preserves input order.
`--sum` and `--avg` each accept one column and require `--group-by`. Grouping alone
returns distinct group values. Groups sort lexicographically.

Output defaults to a JSON array; `--output csv` emits a header even for an empty
result. Original cells and aggregate values are strings. Aggregates are named
`sum_COLUMN` and `avg_COLUMN`; names must not collide with the group column.
Sums use exact decimal arithmetic. Averages use decimal round-half-even with at
least 28 significant digits (more for large totals); repeating fractions are
rounded. Decimal strings have no exponent or unnecessary trailing zeros.

Quoted commas and embedded newlines are supported. Headers must be non-empty
and unique, and every record must have the header's field count. Invalid queries
and malformed input report errors on stderr and exit non-zero. Numeric cells in
filtered-in rows must be finite, non-blank decimals. Numeric errors identify the
column and CSV record number, counting the header as row 1. Results are buffered
so input errors do not produce partial output.

Run the self-tests with:

```sh
python3 -m unittest discover -s tests -v
```
