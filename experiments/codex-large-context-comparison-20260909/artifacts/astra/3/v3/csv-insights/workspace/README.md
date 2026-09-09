# CSV Insights

A dependency-free Python 3.11+ CLI for filtering CSV files and calculating grouped totals and averages.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --where status=paid --group-by region --sum amount --avg amount
python3 main.py sales.csv --group-by region --sum amount --output csv
python3 -m unittest discover -v
```

JSON is the default output. Repeated `--where COLUMN=VALUE` options compare exact strings with AND; values may contain `=`. Filtering preserves input order. `--group-by` sorts groups lexicographically; alone it returns distinct group values. Both `--sum` and `--avg` require grouping.

Input is UTF-8 (an optional BOM is accepted), with CSV quoting supporting commas and embedded newlines. Headers must be non-empty and unique, and all records must have the correct field count. Unknown columns, malformed input, and invalid arguments produce stderr errors and a nonzero exit status. The input is opened read-only.

Aggregate fields are named `sum_COLUMN` and `avg_COLUMN`. Numbers use decimal arithmetic and are emitted as minimal plain decimal strings, including in JSON. Sums retain all input digits; averages use at least 28 significant digits and round half-even when needed. Numeric cells in matching rows accept signed decimals and scientific notation, with surrounding whitespace ignored; blanks and non-finite values are errors. Error row numbers count CSV records (header is row 1), so embedded newlines do not increase the record number. Empty results produce `[]` in JSON or just the CSV header.
