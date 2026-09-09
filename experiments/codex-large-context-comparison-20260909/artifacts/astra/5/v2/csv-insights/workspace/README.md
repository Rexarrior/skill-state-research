# CSV Insights

A dependency-free Python 3.11+ CLI for UTF-8 CSV files (optional BOM).

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --where status=paid --group-by region --sum revenue --avg revenue
python3 main.py sales.csv --output csv
python3 -m unittest discover -v
```

Repeat `--where COLUMN=VALUE` to combine exact, case-sensitive comparisons with
AND. Values may be empty or contain `=`. Quote arguments containing shell spaces.
Without grouping, rows and columns keep their input order. `--group-by` emits
lexicographically sorted groups; alone it emits distinct group values. `--sum`
and `--avg` require grouping and create `sum_COLUMN` and `avg_COLUMN` fields.

JSON (the default) is an array of objects; all values, including aggregates, are
strings. CSV includes a header, CRLF record endings, and standard quoting.
Decimals use plain minimal strings, without floating-point conversion. Sums are
exact; terminating averages retain precision, while repeating averages round
half-even to at least 28 significant digits. Numeric cells accept decimal and
scientific notation and surrounding whitespace; blanks, NaN, and infinity fail.
Only rows passing the filters are evaluated numerically.

Headers must be non-blank and unique. Unknown columns, malformed filters, invalid
CSV, and incorrect field counts fail with an error on stderr and a nonzero exit
status. Every row's field count is checked, even if filtered out. Numeric errors
identify the column and logical CSV row (header is row 1; embedded newlines do
not add rows). Output column name collisions are rejected. Empty selections
produce `[]` in JSON or just a CSV header. Input is opened read-only and fully
validated before results are emitted.
