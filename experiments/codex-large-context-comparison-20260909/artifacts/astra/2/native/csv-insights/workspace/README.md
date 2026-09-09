# CSV Insights

A dependency-free command-line CSV tool for Python 3.11+. Input is UTF-8
(an optional BOM is accepted); the input file is never modified.

```sh
python3 main.py sales.csv
python3 main.py sales.csv --where region=West --where status=paid --output csv
python3 main.py sales.csv --group-by region --sum revenue --avg revenue
```

Repeat `--where COLUMN=VALUE` to combine exact, case-sensitive string filters
with AND. Empty values and values containing `=` are supported. Quote arguments
containing shell-special characters or spaces.

Output defaults to JSON, an array of objects with string values. Use `--output
csv` for CSV with a header, even when no rows match. Without `--sum` or `--avg`,
filtered rows retain their original order (`--group-by` alone does not alter
them). Either aggregation requires `--group-by`. Groups are sorted
lexicographically, with output columns `<group>`, `sum_<column>`, and/or
`avg_<column>` in that order.

Aggregation uses Decimal, exact sums, and plain decimal strings without
unnecessary trailing zeros. Averages use at least 28 significant digits and
round half to even when division does not terminate. Numeric cells may contain
surrounding whitespace and scientific notation; blank cells, NaN, and infinity
are errors. Numeric validation applies to rows that pass the filters. Row
numbers count CSV records, including the header as row 1, even for records
containing embedded newlines.

Empty or duplicate headers, incorrect field counts (including in filtered-out
rows), malformed CSV, unknown columns, and invalid arguments produce an error
on stderr and a nonzero exit status. All input is validated before output.

Run the self-tests:

```sh
python3 -m unittest discover -v
```
