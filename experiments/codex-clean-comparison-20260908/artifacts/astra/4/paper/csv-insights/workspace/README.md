# CSV Insights

A dependency-free Python 3.11+ CLI for UTF-8 CSV files.

```sh
python3 main.py sales.csv --where region=West
python3 main.py sales.csv --where active=yes --group-by region --sum revenue --avg revenue --output csv
python3 -m unittest discover -v
```

Repeated `--where COLUMN=VALUE` filters combine with AND and compare exact
strings. Values may contain `=`; quote shell arguments containing spaces.
The default output is a JSON array. `--output csv` writes a header, including
when no rows match. Unaggregated rows retain input order and string values.

`--sum` and `--avg` require `--group-by`. Groups sort lexicographically;
`--group-by` alone emits distinct group values. Aggregates are named
`sum_COLUMN` and `avg_COLUMN`. JSON aggregates are decimal **strings** to
preserve precision. Sums are exact; averages use at least 28 significant digits
with Decimal's half-even rounding. Output uses plain minimal decimal notation.

Headers must be non-empty and unique. Every record must have the header's
field count. Numeric cells in matching records must be nonblank, finite Decimal
values (scientific notation is accepted). Errors go to stderr with a nonzero
exit status; numeric errors identify the logical record number (header is 1)
and column. Quoted commas, quotes, and embedded newlines are supported. A group
column name that collides with an aggregate output name is rejected.

The input is opened read-only. Validation completes before output is emitted.
