# CSV Insights

CSV Insights is a dependency-free Python 3.11+ command-line tool for filtering
CSV files and calculating grouped sums and averages with exact decimal input.

```console
python3 main.py INPUT.csv [--where COLUMN=VALUE ...] [--group-by COLUMN] \
  [--sum COLUMN] [--avg COLUMN] [--output json|csv]
```

Filters are exact string comparisons and repeated filters are combined with
AND. Aggregation requires `--group-by`; results are sorted by the group value.
The default output is JSON. Aggregate values are emitted as minimal decimal
strings (including in JSON), avoiding floating-point loss.

Examples:

```console
python3 main.py sales.csv --where region=west
python3 main.py sales.csv --group-by region --sum revenue --avg revenue --output csv
```

Input must be UTF-8 CSV with a non-empty, unique header and the same field count
in every record. Quoted commas and embedded newlines are supported. Errors are
reported on stderr with a non-zero exit status; the input file is only read.

Run the self-tests with:

```console
python3 -m unittest discover -s tests -v
```
