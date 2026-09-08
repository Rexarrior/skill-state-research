# CSV Insights

A dependency-free Python 3.11+ CSV analytics CLI.

```sh
python3 main.py INPUT.csv --where region=West --where status=paid
python3 main.py INPUT.csv --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

Output defaults to JSON; `--output csv` writes a header and quoted CSV.
Values, including aggregate results, are strings in JSON. Input is read as
UTF-8 (an optional BOM is accepted), with quoted commas and embedded newlines.
The input file is never modified.

Repeated filters use AND and exact string matching. Split filters at the first
`=`; empty values are allowed. Ungrouped rows retain input order. `--group-by`
alone returns distinct groups; grouped results sort by the group string.
`--sum` and `--avg` require `--group-by` and produce `sum_COLUMN` and
`avg_COLUMN`. Sums use exact decimal arithmetic; averages use at least 28
significant digits, rounding repeating results with decimal half-even rounding.
Numbers use plain notation without redundant trailing fractional zeroes.

Empty/duplicate headers, unknown columns, incorrect row widths, malformed CSV,
and invalid arguments fail with a stderr message and nonzero exit code.
Numeric cells in filtered-in rows must be finite and nonblank. Numeric errors
identify the column and logical CSV row (header is row 1, even when a record
spans physical lines). Row widths are checked even for excluded rows.
