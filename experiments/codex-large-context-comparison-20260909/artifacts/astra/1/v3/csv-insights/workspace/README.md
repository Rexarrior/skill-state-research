# CSV Insights

A dependency-free Python 3.11+ command-line tool for UTF-8 CSV files.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --where region=West --where status=paid --group-by product --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

Repeat `--where COLUMN=VALUE` to combine exact, case-sensitive string filters
with AND. Values may be empty or contain `=`; quote shell arguments containing
spaces. Rows retain input order unless `--group-by` is used. Grouping alone
returns distinct group values; groups sort lexicographically. `--sum` and
`--avg` each accept one column and require `--group-by`.

Output defaults to a JSON array. All values are strings, including decimal
aggregates. CSV output always includes a header, even for no results. Aggregate
columns are named `sum_COLUMN` and `avg_COLUMN`. Sums preserve all decimal
digits; averages use at least 28 significant digits (half-even rounding).
Numbers use plain minimal decimal notation, without binary float conversion.

Quoted commas, quotes, and embedded newlines are supported. Headers must be
non-empty and unique; every data record must have the header's field count.
Numeric validation applies to filtered-in rows and requested aggregate columns;
blank, invalid, and non-finite numbers are rejected. Error row numbers count
CSV records, starting with the header as row 1, even for multiline records.
Invalid input or arguments produce a nonzero exit status and a stderr message.
The input is only opened for reading; validation finishes before output begins.
