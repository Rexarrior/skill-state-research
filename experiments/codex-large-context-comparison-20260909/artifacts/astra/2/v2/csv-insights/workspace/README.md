# CSV Insights

A dependency-free Python 3.11+ command-line CSV analytics tool.

```sh
python3 main.py INPUT.csv --where region=West --where status=paid
python3 main.py INPUT.csv --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

Options: repeat `--where COLUMN=VALUE` for exact, case-sensitive AND filters;
`--group-by COLUMN` groups and sorts lexicographically; `--sum COLUMN` and
`--avg COLUMN` require grouping. Grouping alone returns distinct group values.
The default output is JSON; `--output csv` includes a header, even for no matches.
Values, including aggregate results, are strings in JSON. Ungrouped rows retain
input order. Filters may include empty values or additional equals signs.

Input is UTF-8 (an optional BOM is accepted), with CSV quoting for commas,
quotes, and embedded newlines. Headers must be unique and nonblank; every record
must match their field count, including records excluded by filters. Numeric
validation applies to matching records only. Decimal and scientific notation
are accepted, with surrounding numeric whitespace ignored. Blanks, infinities,
and NaNs are rejected. Sums preserve decimal precision; averages use half-even
rounding at at least 28 significant digits (more for large exact totals).
Results use plain decimal notation without unnecessary trailing zeros.

Errors go to stderr with a nonzero exit status. Numeric errors identify the
column and logical record number (header is record 1; embedded newlines do not
increment record numbers). Input is only opened for reading. Results are held
in memory and emitted after validation succeeds.
