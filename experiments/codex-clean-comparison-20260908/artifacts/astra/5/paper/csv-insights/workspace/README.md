# CSV Insights

A dependency-free Python 3.11+ command-line tool for UTF-8 CSV files.

```sh
python3 main.py INPUT.csv --where region=West --where status=paid
python3 main.py INPUT.csv --group-by region --sum revenue --avg revenue --output csv
```

`--output` defaults to `json`. Filters compare exact strings and combine with AND;
values may contain `=` or be empty. Quote arguments containing shell metacharacters.
Without grouping, matching rows retain their input order and original strings.
`--group-by` emits sorted, distinct group values; `--sum` and `--avg` require it.
Both aggregates may target the same column or different columns.

Aggregate fields are named `sum_COLUMN` and `avg_COLUMN`. JSON values, including
aggregates, are strings. Decimal results use plain notation with no redundant
fractional zeros. Sums are exact; terminating averages preserve all digits and
recurring averages use at least 28 significant digits, rounded half-even.
Numeric cells accept signed decimals and scientific notation, with surrounding
whitespace ignored. Blank cells, NaN, and infinity are rejected in matching rows.

Headers must be nonblank and unique. Every row, including filtered-out rows, must
have the correct field count. Error row numbers count CSV records (header is row
1), so embedded newlines do not increment record numbers. Unknown columns,
malformed input, and invalid options produce stderr diagnostics and a nonzero
exit status. A group column that collides with an aggregate field is rejected.
Header-only input produces `[]` in JSON or a header in CSV. Input files are only
opened for reading.

Run the self-tests:

```sh
python3 -m unittest discover -v
```
