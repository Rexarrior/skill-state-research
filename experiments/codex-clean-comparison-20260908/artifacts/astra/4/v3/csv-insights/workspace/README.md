# CSV Insights

A dependency-free Python 3.11+ CLI for filtering CSV files and computing grouped decimal sums and averages.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --where status=paid --group-by region --sum revenue --avg revenue
python3 main.py sales.csv --group-by region --sum revenue --output csv
python3 -m unittest discover -v
```

Repeat `--where COLUMN=VALUE` to combine exact, case-sensitive filters with AND. Values may be empty or contain `=`; quote arguments containing shell metacharacters or spaces. Output defaults to JSON, with all values (including aggregates) represented as strings. CSV output includes a header, even when no rows match.

`--sum` and `--avg` each accept one column and require `--group-by`. Using only `--group-by` lists distinct groups. Groups sort lexicographically; ungrouped rows retain input order. Numeric cells in matching rows accept signed decimal and scientific notation with surrounding whitespace. Blank, invalid, and non-finite numbers are rejected. Sums are exact; averages use Decimal division with at least 28 significant digits and half-even rounding when necessary. Results use plain decimal strings without unnecessary trailing zeros.

Input is UTF-8 CSV, supports quoted commas and embedded newlines, and is opened read-only. Headers must be non-empty and unique. Every record must have the header's field count, including records excluded by filters. Errors go to stderr with a nonzero exit code. Numeric errors identify the logical CSV row (header is row 1) and column; CSV syntax errors report the physical line. No output is emitted until validation completes. Generated aggregate names that collide with the group column are rejected.
