# CSV Insights

A dependency-free Python 3.11+ command-line tool for UTF-8 CSV files.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --where status=paid --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

`--where COLUMN=VALUE` may be repeated; all filters must match exactly. Values
may be empty or contain `=`. Quote shell arguments containing spaces.
`--output` defaults to `json`; `csv` includes a header even with no matches.
All JSON values, including aggregates, are strings.

Without aggregation, matching rows retain their input order. Combine
`--group-by COLUMN` with `--sum COLUMN`, `--avg COLUMN`, or both to return
groups in lexicographic order with `sum_COLUMN` and `avg_COLUMN` fields.
Both numeric options require grouping. Numeric cells in matching rows accept
signed decimals and scientific notation, with optional surrounding whitespace;
blank, non-finite, and invalid values are errors. Sums are exact; averages use
Decimal arithmetic with at least 28 significant digits and half-even rounding.
Results use plain decimal strings without redundant fractional zeros.

Input supports quoted commas, escaped quotes, embedded newlines, and an optional
UTF-8 BOM. Headers must be non-empty and unique. Every record, including records
excluded by filters, must have the correct field count. Errors go to stderr
with a nonzero exit status; numeric errors identify the CSV record number
(header is record 1) and column. The input file is opened only for reading.
