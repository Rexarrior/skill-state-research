# CSV Insights

CSV Insights is a dependency-free command-line tool for filtering CSV files and
calculating grouped sums and averages. It requires Python 3.11 or newer.

```text
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN]
                          [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters compare exact strings and repeated `--where` options combine with AND.
`--sum` and `--avg` require `--group-by`; they may be used separately or
together. Output defaults to JSON. Decimal aggregate values are emitted as
strings so their exact representation is preserved in JSON.

Examples:

```bash
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --group-by region --sum revenue --avg units
python3 main.py sales.csv --group-by region --sum revenue --output csv
```

The input must have a non-empty, unique header row, and every record must have
the same number of fields. The standard-library CSV parser supports quoted
commas and embedded newlines. Invalid input and arguments produce a non-zero
exit status and a diagnostic on standard error. The input file is only read.
