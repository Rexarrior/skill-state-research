# CSV Insights

A dependency-free Python 3.11+ CLI for filtering and aggregating UTF-8 CSV files.

```sh
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] [--sum COLUMN] [--avg COLUMN] [--output json|csv]
python3 main.py sales.csv --where region=West --group-by product --sum revenue --avg revenue
python3 main.py sales.csv --where region=West --output csv
```

Filters compare exact strings, combine with AND, and split on the first `=` (empty values are allowed). Quote arguments containing shell special characters or spaces. Filtering happens before aggregation. Selected numeric cells must contain finite decimal numbers; surrounding whitespace and scientific notation are accepted. Invalid row widths are rejected even for filtered-out rows.

Without grouping, rows retain input order. Groups sort lexicographically; `--group-by` alone lists distinct values. Sum and average require grouping and produce `sum_COLUMN` and `avg_COLUMN`. Sums are exact; averages use at least 28 significant Decimal digits, with half-even rounding for repeating results. Output decimals use plain minimal strings, including in JSON, to preserve precision. All other cells remain strings.

JSON is the default. CSV output includes a header even with no results, uses CRLF record endings, and quotes commas, quotes, and newlines. Input may use a UTF-8 BOM. Empty/duplicate headers, wrong field counts, malformed CSV, unknown columns, and invalid arguments fail with a nonzero exit and stderr diagnostic. Row numbers count logical CSV records, with the header as row 1. Output column name collisions are rejected. The input is opened read-only; validation completes before output is written.

Run the self-tests:

```sh
python3 -m unittest discover -s tests -v
```
