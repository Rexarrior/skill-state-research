# CSV Insights

A dependency-free Python 3.11+ command-line tool for UTF-8 CSV files.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

Options: repeat `--where COLUMN=VALUE` for exact, AND-combined string filters;
`--group-by COLUMN` groups matching rows; `--sum COLUMN` and `--avg COLUMN`
require grouping. Output defaults to `--output json`; `--output csv` includes a
header. A filter value can be empty or contain `=`. Quote shell arguments as needed.

Unaggregated rows retain input order and string values. Groups sort
lexicographically; without `--sum` or `--avg`, `--group-by` preserves rows. Aggregate names
are `sum_COLUMN` and `avg_COLUMN`. Numbers are decimal strings in both formats,
without trailing fractional zeros or scientific notation. Sums preserve decimal
precision; repeating averages are rounded with decimal half-even rounding to at
least 28 significant digits (precision increases with operand size).

Headers must be non-empty and unique, and every record must have the header's
field count. Numeric cells in matching rows must be non-blank, finite decimals.
Structural CSV errors are checked even in excluded rows. Error row numbers count
CSV records, with the header as row 1, including records with embedded newlines.
Malformed CSV, unknown columns, conflicting output names, and invalid arguments
produce stderr diagnostics and a non-zero exit status. Input files are opened
read-only; results are emitted only after all input has been validated.
