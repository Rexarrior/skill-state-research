# CSV Insights

A dependency-free Python 3.11+ CSV analytics CLI.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --where status=paid --group-by region --sum revenue --avg revenue
python3 main.py sales.csv --output csv
python3 -m unittest discover -v
```

Repeat `--where COLUMN=VALUE` to combine exact, case-sensitive comparisons with
AND. Values may be empty or contain `=`; quote shell arguments containing spaces.
JSON is the default output. Unaggregated rows retain input order. `--group-by`
returns sorted unique groups; `--sum` and `--avg` require it and may be combined.
Aggregate columns are named `sum_COLUMN` and `avg_COLUMN`.

Input is UTF-8 CSV with non-empty, unique headers and consistent row widths.
Quoted commas and embedded newlines are supported. Invalid input or arguments
produce a nonzero exit status and a diagnostic on stderr. Numeric errors identify
the column and logical CSV row (header is row 1). Numeric validation applies to
rows that pass the filters; row widths are always validated. Nonfinite numbers
and blank numeric cells are rejected. Output column name collisions are rejected.

Sums use exact Decimal arithmetic. Averages use at least 28 significant digits
(round half even); repeating fractions are rounded. Aggregate values are minimal
plain decimal **strings**, including in JSON, to preserve precision. CSV output
includes headers even when no rows match. Input files are only opened for reading.
